import { scope } from "./state.mjs";
import { query, schema, description } from "./history.mjs";
import { serve } from "./bridge.mjs";

export default {
  id: "wechat-desk",
  async setup(ctx) {
    const sc = await scope(ctx.location.directory);
    try {
      await sc.grant("zero");
    } catch {
      return;
    }
    const ctrl = new AbortController();
    await ctx.tool.transform((editor) =>
      editor.add({
        name: "wechat_history_query",
        description,
        input: schema,
        execute: async (input, turn) => {
          // Caller supplies search terms only. The host's location selects the grant.
          const session = await ctx.session.get({ sessionID: turn.sessionID });
          const loc = session.location?.directory ?? session.directory;
          if (!loc || (await scope(loc)).root !== sc.root)
            throw Error("会话不属于已授权 workspace");
          return {
            content: JSON.stringify(
              await query(sc, "zero", input, turn.signal),
            ),
          };
        },
      }),
    );
    const job = serve(ctx, sc, ctrl.signal).catch(async () => {
      if (!ctrl.signal.aborted)
        await sc
          .save("health", { status: "stopped", time: Date.now() })
          .catch(() => {});
    });
    return async () => {
      ctrl.abort();
      await job;
    };
  },
};
