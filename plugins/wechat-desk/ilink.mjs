import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
const BASE = "https://ilinkai.weixin.qq.com";
const info = {
  channel_version: "2.4.10/zero-0.2.0",
  bot_agent: "ZeroWechatDesk/0.2.0",
};
function origin(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    !(
      u.hostname === "ilinkai.weixin.qq.com" ||
      u.hostname.endsWith(".weixin.qq.com")
    ) ||
    u.port ||
    u.username ||
    u.password
  )
    throw Error("微信服务地址无效");
  return u.origin;
}
export function ilink(request = fetch) {
  async function call(
    base,
    path,
    { body, token, signal, timeout = 40000 } = {},
  ) {
    const headers = {
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String(0x02040a),
    };
    if (body)
      Object.assign(headers, {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": Buffer.from(
          String(randomBytes(4).readUInt32BE()),
        ).toString("base64"),
      });
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await request(origin(base) + "/ilink/bot/" + path, {
      headers,
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });
    if (!r.ok) throw Error(`微信接口 HTTP ${r.status}`);
    const raw = await r.text();
    const j = raw.trim()
      ? JSON.parse(raw, (k, v, c) =>
          ["message_id", "seq"].includes(k) &&
          typeof v === "number" &&
          !Number.isSafeInteger(v)
            ? (c?.source ?? null)
            : v,
        )
      : {};
    const code = Number(j.errcode) || Number(j.ret) || 0;
    if (code) throw Object.assign(Error(`微信接口错误 ${code}`), { code });
    return j;
  }
  return {
    async bind({ show, pin, signal, previous }) {
      for (let round = 0; round < 3; round++) {
        const q = await call(BASE, "get_bot_qrcode?bot_type=3", {
          body: { local_token_list: previous ? [previous.token] : [] },
          signal,
        });
        if (!q.qrcode || !q.qrcode_img_content)
          throw Error("微信没有签发二维码");
        await show(q.qrcode_img_content);
        let base = BASE,
          code = "";
        const until = Date.now() + 180000;
        while (Date.now() < until) {
          let s;
          const params = new URLSearchParams({ qrcode: q.qrcode });
          if (code) params.set("verify_code", code);
          try {
            s = await call(base, "get_qrcode_status?" + params, { signal });
          } catch (e) {
            if (e.name === "TimeoutError") continue;
            throw e;
          }
          code = "";
          if (s.status === "confirmed") {
            if (!s.bot_token || !s.ilink_user_id || !s.ilink_bot_id)
              throw Error("绑定响应不完整");
            return {
              base: origin(s.baseurl || BASE),
              user: s.ilink_user_id,
              bot: s.ilink_bot_id,
              token: s.bot_token,
            };
          }
          if (s.status === "binded_redirect" && previous) return previous;
          if (s.status === "binded_redirect")
            throw Error("微信已绑定，但本机没有对应凭据");
          if (["expired", "verify_code_blocked"].includes(s.status)) break;
          if (String(s.status).includes("need_verifycode")) {
            code = (await pin()).trim();
            if (!/^\d{1,12}$/.test(code)) throw Error("验证码必须为数字");
          }
          if (s.status === "scaned_but_redirect")
            base = origin("https://" + s.redirect_host);
          await wait(800, undefined, { signal });
        }
      }
      throw Error("二维码已过期，请重新绑定");
    },
    poll: (b, cursor, signal) =>
      call(b.base, "getupdates", {
        token: b.token,
        body: { get_updates_buf: cursor || "", base_info: info },
        signal,
      }),
    send: (b, text, context, id = randomUUID(), signal) =>
      call(b.base, "sendmessage", {
        token: b.token,
        signal,
        body: {
          base_info: info,
          msg: {
            from_user_id: "",
            to_user_id: b.user,
            client_id: id,
            message_type: 2,
            message_state: 2,
            ...(context ? { context_token: context } : {}),
            item_list: [{ type: 1, text_item: { text } }],
          },
        },
      }),
  };
}
