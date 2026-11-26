import { spawn } from "node:child_process";
import { join } from "node:path";
import { classifyFailure } from "./errors.mjs";
import { assertSupportedWechat, resolveToolchain } from "./toolchain.mjs";

export const OPS = new Set(["list", "read", "search", "recent", "summary", "events"]);

function normalize({ op, value, days = 7, limit = 30, offset = 0 }) {
  if (!OPS.has(op)) return null;
  if (typeof value !== "string") value = "";
  if (value.length > 180 || value.includes("\0")) return null;
  if ((op === "read" || op === "search") && !value.trim()) return null;
  if (!Number.isInteger(days) || days < 1 || days > 3650) return null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return null;
  if (!Number.isInteger(offset) || offset < 0) return null;
  return { op, value, days, limit, offset };
}

function argv(q) {
  const a = [q.op, "--json"];
  if (q.op !== "list") a.push("-d", String(q.days));
  if (q.op !== "summary") a.push("-n", String(q.limit));
  if (q.op === "list" && q.offset > 0) a.push("--offset", String(q.offset));
  if (q.op === "read" || q.op === "search") a.push("--", q.value);
  if (q.op === "events" && q.value) a.push("--event=" + q.value);
  return a;
}

export async function queryOnce(opts) {
  const q = normalize(opts);
  if (!q) return { ok: false, code: "BAD_ARGS" };

  const unsupported = await assertSupportedWechat(opts.root);
  if (unsupported) return { ok: false, code: "UNSUPPORTED_WECHAT" };

  const { python, env } = await resolveToolchain(opts.root, { python: opts.python });
  const script = join(opts.root, "query", "scripts", "common", "query.py");

  return await new Promise((resolve) => {
    const child = spawn(python, [script, ...argv(q)], {
      cwd: join(opts.root, "query"),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 45_000);

    // Decode through a StringDecoder: a chunk boundary must never split a
    // multi-byte character into replacement characters.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, code: "IO_ERROR" });
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, code: "TIMEOUT" });
      const text = stdout.trim();
      if (!text) return resolve({ ok: false, code: classifyFailure(stderr) });
      try {
        return resolve({ ok: true, data: JSON.parse(text) });
      } catch {
        return resolve({ ok: false, code: "IO_ERROR" });
      }
    });
  });
}
