import { scope } from "./state.mjs";
import { query, description, schema } from "./history.mjs";
export default {
  id: "wechat-desk",
  name: "微信工作台",
  register(api) {
    api.registerTool(
      (ctx) => {
        if (
          !ctx.workspaceDir ||
          ctx.messageChannel !== "openclaw-weixin" ||
          !ctx.requesterSenderId
        )
          return null;
        return {
          name: "wechat_history_query",
          description,
          parameters: schema,
          async execute(_id, input, signal) {
            const sc = await scope(ctx.workspaceDir),
              g = await sc.grant("openclaw");
            const peer = String(
              ctx.nativeChannelId || ctx.deliveryContext?.to || "",
            ).replace(/^openclaw-weixin:/, "");
            if (g.owner !== ctx.requesterSenderId || peer !== g.owner)
              throw Error("只有已授权的微信私聊可以查询");
            const result = await query(sc, "openclaw", input, signal);
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          },
        };
      },
      {
        name: "wechat_history_query",
        promptGuidance:
          "微信历史类问题先使用只读查询，附会话、时间和原话。代回消息只拟草稿，普通回复回到当前 ClawBot，不代发到原群。",
      },
    );
  },
};
