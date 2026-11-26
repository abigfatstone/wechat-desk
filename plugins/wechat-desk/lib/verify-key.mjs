import { spawn } from "node:child_process";
import { join } from "node:path";
import { classifyFailure } from "./errors.mjs";
import { assertSupportedWechat, resolveToolchain } from "./toolchain.mjs";

// Runs inside the query layer so key derivation is upstream's own logic, not a
// second implementation. The key arrives on stdin: never argv, never env.
// Failures come back as text; lib/errors.mjs turns them into a code. The text
// is never returned to the caller because a traceback can echo the key back.
const SCRIPT = `
import json, os, sys
sys.path.insert(0, ".")
db_path = sys.argv[1]
key = sys.stdin.readline().strip()
def fail(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(0)
if not os.path.isfile(db_path):
    fail("missing database file")
try:
    import db
except Exception as exc:
    fail("import failed: %s" % exc)
try:
    db._run_sqlcipher(db_path, db.preamble(key, db_path) + "SELECT count(*) FROM sqlite_master;\\n", 10)
except Exception as exc:
    fail(str(exc)[:400])
try:
    tables = int(db._run_sqlcipher(db_path, db.preamble(key, db_path) + "SELECT count(*) FROM sqlite_master WHERE type='table';\\n", 10).split()[-1])
    names = [l.strip() for l in db._run_sqlcipher(db_path, db.preamble(key, db_path) + "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%';\\n", 10).split("\\n") if l.strip().startswith("Msg_")]
    messages = 0
    for n in names:
        sql = 'SELECT count(*) FROM "%s";' % n + "\\n"
        messages += int(db._run_sqlcipher(db_path, db.preamble(key, db_path) + sql, 60).split()[-1])
    print(json.dumps({"ok": True, "tables": tables, "messages": messages}))
except Exception as exc:
    fail(str(exc)[:400])
`;

async function attempt({ python, env, queryDir, dbPath, key, timeoutMs }) {
  return await new Promise((resolve) => {
    const child = spawn(python, ["-c", SCRIPT, dbPath], {
      cwd: queryDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

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
      if (timedOut) return resolve({ ok: false, code: "DB_BUSY" });
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      try {
        const parsed = JSON.parse(line);
        if (parsed.ok) return resolve({ ok: true, tables: parsed.tables, messages: parsed.messages });
        return resolve({ ok: false, code: classifyFailure(parsed.error ?? stderr) });
      } catch {
        return resolve({ ok: false, code: classifyFailure(stderr) });
      }
    });
    child.stdin.end(key + "\n");
  });
}

export async function verifyKey(opts) {
  const unsupported = await assertSupportedWechat(opts.root);
  if (unsupported) return { ok: false, code: "UNSUPPORTED_WECHAT" };

  const { python, env } = await resolveToolchain(opts.root, { python: opts.python });
  const queryDir = join(opts.root, "query");
  const args = { python, env, queryDir, dbPath: opts.dbPath, key: opts.key, timeoutMs: opts.timeoutMs ?? 90_000 };

  const first = await attempt(args);
  if (first.ok || first.code !== "DB_BUSY") return first;

  // One retry: a lock is usually a momentary write, not a wrong key.
  await new Promise((r) => setTimeout(r, 200));
  return await attempt(args);
}
