import { randomUUID } from "node:crypto";
// Consume only the runtime's registered agent-network transport. Do not persist its header.
async function network(name, args, signal) {
  const e = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}").mcp
    ?.servers?.["zero-agent-network"];
  if (!e?.url || !e.headers?.Authorization)
    throw Error("此入口没有启用零点 workspace 协作");
  const u = new URL(e.url);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/api/agent-network/local/mcp" ||
    u.search ||
    u.username ||
    u.password
  )
    throw Error("协作入口无效");
  const r = await fetch(u, {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      Authorization: e.headers.Authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!r.ok) throw Error("协作不可用");
  const j = await r.json();
  if (j.error || j.result?.isError) throw Error("目标 workspace 未接受任务");
  return JSON.parse(j.result.content[0].text);
}
function render(t) {
  const label = t.status?.state || "";
  const parts =
    t.message?.parts ?? t.artifacts?.flatMap((a) => a.parts ?? []) ?? [];
  const text =
    parts
      .map((p) => p.text)
      .filter(Boolean)
      .join("\n") ||
    t.status?.message?.parts
      ?.map((p) => p.text)
      .filter(Boolean)
      .join("\n");
  return (text || label || "任务已提交").slice(0, 5000);
}
const done = (t) =>
  !!t.message ||
  [
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
    "TASK_STATE_INPUT_REQUIRED",
    "TASK_STATE_AUTH_REQUIRED",
  ].includes(t.status?.state);
export async function route(sc, input, signal, call = network) {
  const g = await sc.grant("zero"),
    m = input.trim().match(/^@([^\s]{1,40})\s+([\s\S]+)$/u);
  if (m) {
    const target = g.peers?.find((p) => p.name === m[1]);
    if (!target) return "没有授权这个目标。请先在本机设置 workspace 别名。";
    const pending = await sc.load("pending");
    if (pending?.grant === g.id && pending.expires > Date.now())
      return "已有一项待决定的转发，请先回复 1 或 2。";
    const text = m[2].trim();
    if (text.length > 1200) return "单次转发请控制在 1200 字以内。";
    await sc.save("pending", {
      grant: g.id,
      target,
      text,
      id: randomUUID(),
      expires: Date.now() + 300000,
    });
    return `仅将以下文字转给【${target.name}】，不附带聊天库：\n${text}\n5 分钟内回复 1 允许本次转发，2 取消。`;
  }
  if (input === "1" || input === "2") {
    const p = await sc.load("pending");
    await sc.drop("pending");
    if (!p || p.grant !== g.id || p.expires < Date.now())
      return "没有有效的待确认转发。";
    if (input === "2") return "已取消，未转发。";
    if (!g.peers.some((x) => x.name === p.target.name && x.id === p.target.id))
      return "目标已取消授权。";
    const current = await sc.load("job");
    if (current?.grant === g.id && !current.finished)
      return "已有任务未结束，请先发「任务进度」。";
    try {
      const t = await call(
        "send_request",
        { peerId: p.target.id, text: p.text, messageId: p.id },
        signal,
      );
      const text = render(t);
      await sc.save("job", {
        grant: g.id,
        peer: p.target.id,
        name: p.target.name,
        id: t.id ?? null,
        finished: done(t),
        text,
      });
      return `【${p.target.name}】${done(t) ? text : "已提交。可发「任务进度」查看。"}`;
    } catch {
      return "转发未确认，请在零点查看；不会自动重发。";
    }
  }
  if (input === "任务进度") {
    const j = await sc.load("job");
    if (!j || j.grant !== g.id) return "这个入口没有转发任务。";
    if (j.finished || !j.id) return `【${j.name}】${j.text}`;
    try {
      const t = await call(
        "get_task",
        { peerId: j.peer, taskId: j.id },
        signal,
      );
      j.text = render(t);
      j.finished = done(t);
      await sc.save("job", j);
      return `【${j.name}】${j.text}`;
    } catch {
      return "暂时无法查询任务进度。";
    }
  }
  return null;
}

// Claim a finished job once, before any outbound notification. A manual status query still works.
export async function collectCompletion(sc, signal, call = network) {
  const g = await sc.grant("zero"),
    j = await sc.load("job");
  if (
    !j ||
    j.finished ||
    !j.id ||
    j.grant !== g.id ||
    !g.peers?.some((p) => p.id === j.peer)
  )
    return null;
  const t = await call("get_task", { peerId: j.peer, taskId: j.id }, signal);
  if (!done(t)) return null;
  if ((await sc.grant("zero")).id !== g.id) return null;
  j.text = render(t);
  j.finished = true;
  await sc.save("job", j);
  return `【${j.name}】${j.text}`;
}
