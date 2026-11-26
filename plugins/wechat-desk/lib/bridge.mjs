import { createHash } from "node:crypto";
import { DeskError } from "./errors.mjs";

const MAX_ANSWER = 1900;
const TRUNCATED = "…（完整答复见零点会话）";
const MAX_ATTEMPTS = 3;
const MAX_PENDING = 50;

const digest = (s) => createHash("sha256").update(s).digest("hex").slice(0, 32);

function textOf(m) {
  return (m.item_list ?? [])
    .map((i) => (i.type === 1 ? i.text_item?.text : i.type === 3 ? i.voice_item?.text : ""))
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}

// WeChat's getupdates is consume-on-read: once polled, a message is gone from
// the server. So anything we pulled is written to `pending` before we try to
// answer it, and only leaves `pending` once the reply is actually sent (or the
// attempts run out). A model outage now costs a retry, not the message.
export async function serveOnce({ ilink, binding, state, answer, save = async () => {} }) {
  const next = { ...state, seen: [...(state.seen ?? [])], pending: [...(state.pending ?? [])] };
  if (next.bot !== binding.bot) {
    next.bot = binding.bot;
    next.seen = [];
    next.pending = [];
    next.cursor = "";
  }

  const page = await ilink.poll(binding, next.cursor);
  let skipped = 0;

  for (const m of page.msgs ?? []) {
    if (m.from_user_id !== binding.user || m.group_id || m.message_type !== 1) {
      skipped++;
      continue;
    }
    if (m.message_state != null && m.message_state !== 2) {
      skipped++;
      continue;
    }
    if (m.to_user_id && m.to_user_id !== binding.bot) {
      skipped++;
      continue;
    }

    const rawId = m.message_id ?? m.client_id ?? m.seq;
    if (!rawId) {
      skipped++;
      continue;
    }
    const key = digest(`${binding.bot}:${rawId}`);
    if (next.seen.includes(key) || next.pending.some((p) => p.key === key)) {
      skipped++;
      continue;
    }

    next.pending.push({
      key,
      text: textOf(m),
      context: m.context_token ?? null,
      at: Date.now(),
      attempts: 0,
    });
  }

  if (page.get_updates_buf) next.cursor = page.get_updates_buf;
  if (next.pending.length > MAX_PENDING) next.pending = next.pending.slice(-MAX_PENDING);

  // Persist the cursor and the queue before any work: a crash here loses
  // nothing, and a restart resumes the same queue.
  await save(next);

  let sent = 0;
  let failed = 0;

  for (const item of [...next.pending]) {
    let reply;
    try {
      reply = item.text ? await answer(item.text) : "请发文字或带转写的语音说明要查询哪段历史。";
    } catch (err) {
      failed++;
      item.attempts += 1;
      item.lastError = String(err?.code ?? err?.message ?? err).slice(0, 120);
      if (item.attempts >= MAX_ATTEMPTS) {
        next.pending = next.pending.filter((p) => p.key !== item.key);
        next.seen = [...next.seen.slice(-999), item.key];
      }
      continue;
    }

    const text = reply.length > MAX_ANSWER ? reply.slice(0, MAX_ANSWER - TRUNCATED.length) + TRUNCATED : reply;
    try {
      await ilink.send(binding, text, item.context ?? undefined, item.key);
      sent++;
      next.pending = next.pending.filter((p) => p.key !== item.key);
      next.seen = [...next.seen.slice(-999), item.key];
      if (item.context) next.context = item.context;
      await save(next);
    } catch (err) {
      // -14 means the binding is gone; retrying a send is pointless.
      if (err?.code === -14) throw new DeskError("BIND_EXPIRED");
      failed++;
      item.attempts += 1;
      item.lastError = String(err?.code ?? err?.message ?? err).slice(0, 120);
      if (item.attempts >= MAX_ATTEMPTS) {
        next.pending = next.pending.filter((p) => p.key !== item.key);
        next.seen = [...next.seen.slice(-999), item.key];
      }
    }
  }

  await save(next);
  return { state: next, sent, skipped, failed };
}
