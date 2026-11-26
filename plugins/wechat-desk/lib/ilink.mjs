import { randomBytes, randomUUID } from "node:crypto";

const BASE = "https://ilinkai.weixin.qq.com";
const INFO = { channel_version: "2.4.10/zero-0.3.0", bot_agent: "ZeroWechatDesk/0.3.0" };

// Only WeChat's own hosts: the token is a bearer credential, so a redirect or
// a hostile base URL would hand it away.
function origin(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    !(u.hostname === "ilinkai.weixin.qq.com" || u.hostname.endsWith(".weixin.qq.com")) ||
    u.port ||
    u.username ||
    u.password
  ) {
    throw Error("微信服务地址无效");
  }
  return u.origin;
}

async function call(request, base, path, { body, token, timeout = 40000 } = {}) {
  const headers = {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(0x02040a),
  };
  if (body) {
    Object.assign(headers, {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64"),
    });
  }
  if (token) headers.Authorization = `Bearer ${token}`;

  const r = await request(origin(base) + "/ilink/bot/" + path, {
    headers,
    method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw Error(`微信接口 HTTP ${r.status}`);

  const raw = await r.text();
  const json = raw.trim() ? JSON.parse(raw) : {};
  const code = Number(json.errcode) || Number(json.ret) || 0;
  if (code) throw Object.assign(Error(`微信接口错误 ${code}`), { code });
  return json;
}

export function ilink(request = fetch) {
  return {
    async bind({ show, pin, previous, onPoll }) {
      for (let round = 0; round < 3; round++) {
        const q = await call(request, BASE, "get_bot_qrcode?bot_type=3", {
          body: { local_token_list: previous ? [previous.token] : [] },
        });
        if (!q.qrcode || !q.qrcode_img_content) throw Error("微信没有签发二维码");
        await show(q.qrcode_img_content);

        let base = BASE;
        let code = "";
        const until = Date.now() + 180000;
        while (Date.now() < until) {
          const params = new URLSearchParams({ qrcode: q.qrcode });
          if (code) params.set("verify_code", code);
          const s = await call(request, base, "get_qrcode_status?" + params);
          code = "";

          if (s.status === "confirmed") {
            if (!s.bot_token || !s.ilink_user_id || !s.ilink_bot_id) throw Error("绑定响应不完整");
            return {
              base: origin(s.baseurl || BASE),
              user: s.ilink_user_id,
              bot: s.ilink_bot_id,
              token: s.bot_token,
            };
          }
          if (s.status === "binded_redirect") {
            if (previous) return previous;
            throw Error("微信已绑定，但本机没有对应凭据");
          }
          if (["expired", "verify_code_blocked"].includes(s.status)) break;
          if (String(s.status).includes("need_verifycode")) {
            code = (await pin()).trim();
            if (!/^\d{1,12}$/.test(code)) throw Error("验证码必须为数字");
          }
          if (s.status === "scaned_but_redirect") base = origin("https://" + s.redirect_host);
          if (onPoll) onPoll(s);
          await new Promise((r) => setTimeout(r, 800));
        }
      }
      throw Error("二维码已过期，请重新绑定");
    },

    poll: (binding, cursor) =>
      call(request, binding.base, "getupdates", {
        token: binding.token,
        body: { get_updates_buf: cursor || "", base_info: INFO },
      }),

    send: (binding, text, context, id = randomUUID()) =>
      call(request, binding.base, "sendmessage", {
        token: binding.token,
        body: {
          base_info: INFO,
          msg: {
            from_user_id: "",
            to_user_id: binding.user,
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
