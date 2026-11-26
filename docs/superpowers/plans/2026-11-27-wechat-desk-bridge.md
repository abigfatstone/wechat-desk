# 微信工作台 0.3 · 常驻桥接 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 插件启用后常驻：微信里发一句话，本机查询历史并回一段带出处的答案；宿主关掉窗口、跨对话轮次都不影响。

**Architecture:** `ilink`（微信 bot 通道，可注入 fetch 便于测试）→ `bridge`（轮询、去重、调用注入的 answer、回发）→ `workspace-adapter`（写一行适配文件，让宿主加载插件）→ 插件胶水（注册工具、启动服务）。回答要模型，模型 API 只在零点进程内，所以常驻的是「宿主 + 工作区」，不是另起一个进程。

**Spec:** `docs/superpowers/specs/2026-11-27-one-click-wechat-desk-design.md` §4

## Global Constraints

- 不上传聊天记录；答案由本机查询层产出，只把命中片段交给当前 workspace 配置的模型。
- 只回本人私聊（`from_user_id === binding.user`，无 group_id）；不代发到原群。
- key 与 binding token 只在本机 0600 文件；不写日志、不进 argv。
- 启用即常驻：插件 enabled 就必须在收消息；停用则立即停轮询与查询。
- 单实例：`<root>/receiver.lock` 记录 pid，第二实例直接退出。
- 错误码沿用 `CODES`，新增 `BIND_EXPIRED`（-14）`SEND_UNCONFIRMED`。

## Review Focus

1. **重复回复**：同一条消息被重复 poll 到，不能回两次（seen 集合落盘后再发）。
2. **串号**：只回答绑定本人；陌生人/群消息一律忽略，且不报错刷屏。
3. **断线恢复**：token 失效时停止拉取并标记 `BIND_EXPIRED`，不无限重试烧接口。
4. **停止即停止**：停用后不再有查询子进程、不再有长轮询。
5. **答案边界**：超过 1900 字的答复截断并提示到零点看全文，不静默截胡。

---

### Task 1: ilink 客户端
`lib/ilink.mjs`，从 0.2.0 的 `ilink.mjs` 移植（MIT，同一作者仓库），保持：只信任 `*.weixin.qq.com`、`bot_type=3` 绑定、`getupdates` 长轮询、`sendmessage` 文本。签名：`ilink(fetchImpl)` 返回 `{bind, poll, send}`。测试用假 fetch 覆盖绑定三步状态（confirmed / need_verifycode / expired）、域名校验拒绝、发送体形状。

### Task 2: 桥接循环
`lib/bridge.mjs`：`serveOnce({ilink, binding, state, answer, now})` → `{state, sent, skipped}`。去重键 `hash(bot + message_id)`，先落盘 seen 再发送；`from_user_id` 不匹配或 `group_id` 存在则跳过；`-14` 抛 `BIND_EXPIRED`。测试：重复消息只回一次、陌生人被忽略、-14 终止、截断 1900。

### Task 3: 常驻（工作区适配器）
`lib/workspace-adapter.mjs`：写 `<workspace>/.opencode/plugins/wechat-desk/index.ts`，内容是一行带标记的 `export { default } from "<插件入口>"`；幂等、不覆盖别人的文件、卸载只删自己的。**不用 LaunchAgent**：模型只在零点进程内，自建服务只能收消息不能回答。

### Task 4: 插件胶水
`plugins/wechat-desk/zero.mjs` 改为：读 `<root>/grant.json`，注册 `wechat_history_query` 工具（复用 `lib/query.mjs`），并启动 `bridge`；`answer()` 用 `ctx.session.generate`。`openclaw.mjs` 不再作为入口（保留文件不影响零点的加载）。

### Task 5: 绑定命令
`bin/wechatdesk.mjs bind` —— 调 `ilink.bind`，二维码以文本渲染到终端，凭证写 `<root>/binding.json`（0600）。

## 验收
`node --test test/*.test.mjs` 全绿；用假 fetch 跑通「一条消息 → 一次查询 → 一条回复」；适配器写入后零点加载该工作区，插件 `setup()` 被执行（手动一次）。
