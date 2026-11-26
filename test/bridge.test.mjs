import test from "node:test";
import assert from "node:assert/strict";
import { serveOnce } from "../lib/bridge.mjs";

const BINDING = { base: "https://ilinkai.weixin.qq.com", token: "t", user: "u1", bot: "b1" };

function msg(overrides = {}) {
  return {
    message_id: 1001,
    from_user_id: "u1",
    to_user_id: "b1",
    message_type: 1,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: "上周谁说了交付日期" } }],
    context_token: "ctx",
    ...overrides,
  };
}

function fakes(page, { failSend } = {}) {
  const sent = [];
  const asked = [];
  return {
    sent,
    asked,
    ilink: {
      poll: async () => page,
      send: async (binding, text, context, id) => {
        if (failSend) throw Object.assign(Error("boom"), { code: failSend });
        sent.push({ text, context, id });
      },
    },
    answer: async (q) => {
      asked.push(q);
      return "答复：" + q;
    },
  };
}

test("一条私聊消息触发一次查询并回一条", async () => {
  const f = fakes({ msgs: [msg()], get_updates_buf: "c1" });
  const out = await serveOnce({ ilink: f.ilink, binding: BINDING, state: { bot: "b1", seen: [], cursor: "" }, answer: f.answer });

  assert.equal(f.asked.length, 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /答复：上周谁说了交付日期/);
  assert.equal(f.sent[0].context, "ctx");
  assert.equal(out.state.cursor, "c1");
  assert.equal(out.state.seen.length, 1);
});

test("同一条消息再次 poll 到不会重复回复", async () => {
  const page = { msgs: [msg()], get_updates_buf: "c1" };
  const f = fakes(page);
  const first = await serveOnce({ ilink: f.ilink, binding: BINDING, state: { bot: "b1", seen: [], cursor: "" }, answer: f.answer });
  const second = await serveOnce({ ilink: f.ilink, binding: BINDING, state: first.state, answer: f.answer });
  assert.equal(f.sent.length, 1);
  assert.equal(second.skipped, 1);
});

test("不是本人发的消息一律忽略", async () => {
  const f = fakes({ msgs: [msg({ from_user_id: "stranger" })], get_updates_buf: "" });
  const out = await serveOnce({ ilink: f.ilink, binding: BINDING, state: { bot: "b1", seen: [], cursor: "" }, answer: f.answer });
  assert.equal(f.sent.length, 0);
  assert.equal(out.skipped, 1);
});

test("群消息忽略", async () => {
  const f = fakes({ msgs: [msg({ group_id: "g1" })], get_updates_buf: "" });
  await serveOnce({ ilink: f.ilink, binding: BINDING, state: { bot: "b1", seen: [], cursor: "" }, answer: f.answer });
  assert.equal(f.sent.length, 0);
});

test("超长答复截断并提示到零点看全文", async () => {
  const f = fakes({ msgs: [msg()], get_updates_buf: "" });
  f.answer = async () => "很长的答案".repeat(500);
  await serveOnce({ ilink: f.ilink, binding: BINDING, state: { bot: "b1", seen: [], cursor: "" }, answer: f.answer });
  assert.ok(f.sent[0].text.length <= 1900);
  assert.match(f.sent[0].text, /清零|零点|全文/);
});

test("发送失败 -14 时抛 BIND_EXPIRED", async () => {
  const f = fakes({ msgs: [msg()], get_updates_buf: "" }, { failSend: -14 });
  await assert.rejects(
    () => serveOnce({ ilink: f.ilink, binding: BINDING, state: { bot: "b1", seen: [], cursor: "" }, answer: f.answer }),
    (err) => err.code === "BIND_EXPIRED",
  );
});

test("空消息或语音转写缺失时回一句提示", async () => {
  const f = fakes({ msgs: [msg({ item_list: [] })], get_updates_buf: "" });
  await serveOnce({ ilink: f.ilink, binding: BINDING, state: { bot: "b1", seen: [], cursor: "" }, answer: f.answer });
  assert.equal(f.asked.length, 0);
  assert.match(f.sent[0].text, /文字/);
});

test("回答失败时消息留在 pending，下一轮重试成功后只回一次", async () => {
  const page = { msgs: [msg()], get_updates_buf: "c1" };
  const f = fakes(page);
  let fail = true;
  const answer = async (q) => {
    if (fail) throw Error("model down");
    return f.answer(q);
  };
  const first = await serveOnce({ ilink: f.ilink, binding: BINDING, state: { bot: "b1", seen: [], cursor: "" }, answer });
  assert.equal(f.sent.length, 0);
  assert.equal(first.state.pending.length, 1);
  assert.equal(first.state.pending[0].attempts, 1);
  assert.equal(first.state.seen.length, 0);

  fail = false;
  const second = await serveOnce({ ilink: f.ilink, binding: BINDING, state: first.state, answer });
  assert.equal(f.sent.length, 1);
  assert.equal(second.state.pending.length, 0);
  assert.equal(second.state.seen.length, 1);
});

test("发送失败（非 -14）也留在 pending 里重试", async () => {
  const page = { msgs: [msg()], get_updates_buf: "c1" };
  const sent = [];
  let failSend = true;
  const ilink = {
    poll: async () => page,
    send: async (b, text) => {
      if (failSend) throw Object.assign(Error("network"), { code: -1 });
      sent.push(text);
    },
  };
  const answer = async () => "答案";
  const first = await serveOnce({ ilink, binding: BINDING, state: { bot: "b1", seen: [], cursor: "" }, answer });
  assert.equal(first.state.pending.length, 1);
  assert.equal(sent.length, 0);

  failSend = false;
  await serveOnce({ ilink, binding: BINDING, state: first.state, answer });
  assert.equal(sent.length, 1);
});

test("重试超过上限后丢弃，避免无限重放", async () => {
  const page = { msgs: [msg()], get_updates_buf: "c1" };
  const f = fakes(page);
  const answer = async () => {
    throw Error("always down");
  };
  let state = { bot: "b1", seen: [], cursor: "" };
  for (let i = 0; i < 5; i++) {
    const r = await serveOnce({ ilink: f.ilink, binding: BINDING, state, answer });
    state = r.state;
  }
  assert.equal(state.pending.length, 0);
  assert.equal(state.seen.length, 1);
});

test("处理前先落盘：第一轮 save 就包含 cursor 与 pending", async () => {
  const page = { msgs: [msg()], get_updates_buf: "c9" };
  const f = fakes(page);
  const saves = [];
  const answer = async () => {
    throw Error("down");
  };
  await serveOnce({
    ilink: f.ilink,
    binding: BINDING,
    state: { bot: "b1", seen: [], cursor: "" },
    answer,
    save: async (s) => saves.push(JSON.parse(JSON.stringify(s))),
  });
  assert.ok(saves.length >= 1);
  assert.equal(saves[0].cursor, "c9");
  assert.equal(saves[0].pending.length, 1);
});
