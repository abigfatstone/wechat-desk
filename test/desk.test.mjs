import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { scope } from "../plugins/wechat-desk/state.mjs";
import { answer, batch } from "../plugins/wechat-desk/bridge.mjs";
import { ilink } from "../plugins/wechat-desk/ilink.mjs";
import { route, collectCompletion } from "../plugins/wechat-desk/delegate.mjs";
import { query, argv } from "../plugins/wechat-desk/history.mjs";

async function fixture(t) {
  const dir = await realpath(
    await mkdtemp(join(process.env.TEST_TMP || process.cwd(), ".desk-test-")),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = join(dir, "archive");
  await mkdir(files);
  await writeFile(
    join(files, "group.jsonl"),
    [
      JSON.stringify({
        chat: "样例群",
        time: new Date().toISOString(),
        text: "已确认周五交付",
      }),
      JSON.stringify({
        chat: "样例群",
        time: "2020-01-01",
        text: "上次周二交付",
      }),
    ].join("\n"),
  );
  const sc = await scope(dir, join(dir, "state")),
    g = {
      id: "owner-grant",
      root: sc.root,
      host: "zero",
      source: { kind: "archive", directory: files },
    },
    b = {
      token: "test",
      base: "https://ilinkai.weixin.qq.com",
      bot: "bot",
      user: "owner",
    };
  await sc.save("grant", g);
  await sc.save("binding", b);
  return { sc, g, b, dir };
}

test("本人 ClawBot 提问 → 本机历史 → 工作区留存 → 仅回本人；重放不重复发送", async (t) => {
  const { sc, g, b } = await fixture(t);
  const answers = [],
    saved = [];
  const ctx = {
    session: {
      create: async (x) => {
        assert.equal(x.location.directory, sc.root);
        return { id: "ses_test" };
      },
      generate: async ({ prompt }) => {
        if (prompt.includes("仅返回 JSON"))
          return { text: '{"op":"read","value":"样例群","days":2}' };
        assert.match(prompt, /已确认周五交付/);
        assert.doesNotMatch(prompt, /上次周二/);
        assert.match(prompt, /group.jsonl:1/);
        return { text: "周五交付（group.jsonl:1）。回复草稿：收到。" };
      },
      synthetic: async (x) => saved.push(x),
    },
  };
  const api = ilink(async (url, o) => {
    assert.match(url, /sendmessage$/);
    const { msg } = JSON.parse(o.body);
    assert.equal(msg.to_user_id, "owner");
    assert.equal(msg.context_token, "context");
    answers.push(msg.item_list[0].text_item.text);
    return new Response("{}");
  });
  const m = {
    message_type: 1,
    message_id: 12,
    from_user_id: "owner",
    to_user_id: "bot",
    context_token: "context",
    item_list: [{ type: 1, text_item: { text: "确认了什么？" } }],
  };
  const args = {
    sc,
    g,
    b,
    api,
    state: { bot: "bot", seen: [] },
    page: {
      msgs: [{ ...m, from_user_id: "other" }, { ...m, group_id: "group" }, m],
      get_updates_buf: "new",
    },
    respond: (q) => answer(ctx, sc, q),
  };
  await batch(args);
  await batch({ ...args, state: await sc.load("sync") });
  assert.equal(answers.length, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].resume, false);
  assert.equal((await sc.load("sync")).cursor, "new");
});
test("未授权工作区、错误宿主、撤销或市场停用不可读", async (t) => {
  const { sc, g, dir } = await fixture(t);
  await assert.rejects(query(sc, "openclaw", { op: "list" }));
  const other = join(dir, "second");
  await mkdir(other);
  await assert.rejects(
    query(await scope(other, join(dir, "state")), "zero", { op: "list" }),
  );
  const catalog = join(dir, "installed.json");
  await writeFile(catalog, '{"bundles":[]}');
  await sc.save("grant", { ...g, catalog });
  await assert.rejects(query(sc, "zero", { op: "list" }));
  await sc.drop("grant");
  await assert.rejects(query(sc, "zero", { op: "list" }));
});
test("只读适配层使用确定的子命令和独立 argv，禁止调用方指定目录或其他操作", async (t) => {
  const { sc } = await fixture(t);
  assert.deepEqual(
    argv({ op: "search", value: "-h; CALL", days: 2, limit: 5 }),
    ["search", "--json", "-d", "2", "-n", "5", "--", "-h; CALL"],
  );
  await assert.rejects(
    query(sc, "zero", { op: "search", value: "x", directory: "elsewhere" }),
  );
  await assert.rejects(query(sc, "zero", { op: "exec" }));
});
test("实际启动只读适配子进程，解析上游 JSON", async (t) => {
  const { sc, g, dir } = await fixture(t),
    sub = join(dir, "scripts/common");
  await mkdir(sub, { recursive: true });
  const file = join(sub, "query.py");
  await writeFile(
    file,
    'import sys,json\nprint(json.dumps({"args":sys.argv[1:]}))\n',
  );
  await sc.save("grant", {
    ...g,
    source: {
      kind: "tzwkb",
      directory: dir,
      python: process.env.PYTHON || "python3",
    },
  });
  assert.deepEqual(
    (await query(sc, "zero", { op: "read", value: "模拟群", limit: 3 })).data
      .args,
    ["read", "--json", "-d", "7", "-n", "3", "--", "模拟群"],
  );
});
test("提交失败不宣称送达，也不重复通知；处理过程中撤销不发送", async (t) => {
  const { sc, g, b } = await fixture(t);
  let count = 0;
  const a = {
    sc,
    g,
    b,
    api: {
      send: async () => {
        count++;
        throw Object.assign(Error(), { code: -2 });
      },
    },
    state: { seen: [] },
    page: {
      msgs: [
        {
          from_user_id: "owner",
          message_type: 1,
          message_id: "a",
          item_list: [{ type: 1, text_item: { text: "测试" } }],
        },
      ],
    },
    respond: async () => "已保存",
  };
  await batch(a);
  await batch(a);
  assert.equal(count, 1);
  assert.equal((await sc.load("delivery")).status, "unconfirmed");
  a.page.msgs[0].message_id = "b";
  a.respond = async () => {
    await sc.drop("grant");
    return "不应发送";
  };
  await assert.rejects(batch(a));
  assert.equal(count, 1);
});
test("扫码返回的外部地址被拒绝；合法绑定参数正确", async () => {
  for (const base of [
    "https://untrusted.invalid",
    "https://ilinkai.weixin.qq.com",
  ]) {
    let i = 0;
    const api = ilink(async (u, o) => {
      if (!i++) {
        assert.deepEqual(JSON.parse(o.body), { local_token_list: [] });
        return Response.json({ qrcode: "q", qrcode_img_content: "qr" });
      }
      return Response.json({
        status: "confirmed",
        ilink_user_id: "u",
        ilink_bot_id: "b",
        bot_token: "token",
        baseurl: base,
      });
    });
    const p = api.bind({ show: async (s) => assert.equal(s, "qr") });
    if (base.endsWith(".invalid")) await assert.rejects(p);
    else assert.equal((await p).bot, "b");
  }
});

test("转发必须命中目标白名单并逐次确认；回复不携带聊天库，完成仅通知一次", async (t) => {
  const { sc, g } = await fixture(t);
  await sc.save("grant", { ...g, peers: [{ name: "乙", id: "peer" }] });
  const calls = [];
  const call = async (n, a) => {
    calls.push([n, a]);
    return n === "send_request"
      ? { id: "task", status: { state: "TASK_STATE_WORKING" } }
      : {
          status: { state: "TASK_STATE_COMPLETED" },
          artifacts: [{ parts: [{ text: "已处理" }] }],
        };
  };
  const r = (s) => route(sc, s, undefined, call);
  assert.match(await r("@陌生人 机密"), /没有授权/);
  await r("@乙 起草安排");
  await r("2");
  assert.equal(calls.length, 0);
  await r("@乙 起草安排");
  await r("1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].text, "起草安排");
  assert.equal(calls[0][1].peerId, "peer");
  assert.match(await r("1"), /没有有效/);
  assert.match(await collectCompletion(sc, undefined, call), /已处理/);
  assert.equal(await collectCompletion(sc, undefined, call), null);
});
