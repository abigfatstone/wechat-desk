import { createHash } from "node:crypto";
import { DeskError } from "./errors.mjs";

const MAX_ANSWER = 1900;
const TRUNCATED = "…（完整答复见零点会话）";

const digest = (s) => createHash("sha256").update(s).digest("hex").slice(0, 32);

function textOf(m) {
  return (m.item_list ?? [])
    .map((i) => (i.type === 1 ? i.text_item?.text : i.type === 3 ? i.voice_item?.text : ""))
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}

// One poll cycle. Kept pure so the loop, the schedule and the shutdown are the
// only things a caller has to get right.
export async function serveOnce({ ilink, binding, state, answer }) {
  const next = { ...state, seen: [...(state.seen ?? [])] };
  if (next.bot !== binding.bot) {
    next.bot = binding.bot;
    next.seen = [];
    next.cursor = "";
  }

  const page = await ilink.poll(binding, next.cursor);
  let sent = 0;
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
    if (next.seen.includes(key)) {
      skipped++;
      continue;
    }

    const question = textOf(m);
    const reply = question
      ? await answer(question)
      : "请发文字或带转写的语音说明要查询哪段历史。";

    // Record before the network call: an ambiguous send is never replayed.
    next.seen = [...next.seen.slice(-999), key];
    if (m.context_token) next.context = m.context_token;

    const text = reply.length > MAX_ANSWER ? reply.slice(0, MAX_ANSWER - TRUNCATED.length) + TRUNCATED : reply;
    try {
      await ilink.send(binding, text, m.context_token, key);
      sent++;
    } catch (err) {
      if (err?.code === -14) throw new DeskError("BIND_EXPIRED");
      throw err;
    }
  }

  if (page.get_updates_buf) next.cursor = page.get_updates_buf;
  return { state: next, sent, skipped };
}
