import test from "node:test";
import assert from "node:assert/strict";
import { ilink } from "../lib/ilink.mjs";

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const body = handler(String(url), init);
    return {
      ok: true,
      text: async () => JSON.stringify(body),
    };
  };
  fn.calls = calls;
  return fn;
}

test("绑定：confirmed 时返回 base/user/bot/token", async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.includes("get_bot_qrcode")) return { qrcode: "q1", qrcode_img_content: "https://x/y" };
    return { status: "confirmed", bot_token: "tok", ilink_user_id: "u1", ilink_bot_id: "b1" };
  });
  let shown = null;
  const b = await ilink(fetchImpl).bind({ show: async (u) => (shown = u), pin: async () => "1" });
  assert.equal(b.token, "tok");
  assert.equal(b.user, "u1");
  assert.equal(b.bot, "b1");
  assert.equal(shown, "https://x/y");
});

test("绑定：需要验证码时取 pin 后重试成功", async () => {
  let polls = 0;
  const fetchImpl = fakeFetch((url) => {
    if (url.includes("get_bot_qrcode")) return { qrcode: "q1", qrcode_img_content: "x" };
    polls++;
    if (polls === 1) return { status: "need_verifycode" };
    return { status: "confirmed", bot_token: "t", ilink_user_id: "u", ilink_bot_id: "b" };
  });
  const b = await ilink(fetchImpl).bind({ show: async () => {}, pin: async () => "123456" });
  assert.equal(b.token, "t");
});

test("只信任 weixin.qq.com 域名", async () => {
  const api = ilink(async () => ({ ok: true, text: async () => "{}" }));
  await assert.rejects(() => api.poll({ base: "https://evil.example.com", token: "t" }, ""), /微信服务地址无效/);
});

test("send 只发文本且带 to_user_id", async () => {
  const fetchImpl = fakeFetch(() => ({ errcode: 0 }));
  await ilink(fetchImpl).send({ base: "https://ilinkai.weixin.qq.com", token: "t", user: "u1" }, "你好");
  const body = JSON.parse(fetchImpl.calls.at(-1).init.body);
  assert.equal(body.msg.to_user_id, "u1");
  assert.equal(body.msg.item_list[0].text_item.text, "你好");
  assert.equal(fetchImpl.calls.at(-1).init.headers.Authorization, "Bearer t");
});

test("接口返回 errcode 时抛错并带 code", async () => {
  const fetchImpl = fakeFetch(() => ({ errcode: -14 }));
  await assert.rejects(
    () => ilink(fetchImpl).poll({ base: "https://ilinkai.weixin.qq.com", token: "t" }, ""),
    (err) => err.code === -14,
  );
});
