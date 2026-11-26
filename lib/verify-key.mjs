import { spawn } from "node:child_process";
import { join } from "node:path";

// Runs inside the query layer so key derivation is upstream's own logic, not a
// second implementation. The key arrives on stdin: never argv, never env.
const SCRIPT = `
import json, os, sys
sys.path.insert(0, ".")
db_path = sys.argv[1]
key = sys.stdin.readline().strip()
if not os.path.isfile(db_path):
    print(json.dumps({"ok": False, "code": "IO_ERROR"}))
    sys.exit(0)
try:
    import db
    ok = db.test_key(key, db_path)
except Exception:
    print(json.dumps({"ok": False, "code": "IO_ERROR"}))
    sys.exit(0)
if not ok:
    print(json.dumps({"ok": False, "code": "KEY_INVALID"}))
    sys.exit(0)
try:
    tables = int(db._run_sqlcipher(db_path, db.preamble(key, db_path) + "SELECT count(*) FROM sqlite_master WHERE type='table';\\n", 10).split()[-1])
    names = [l.strip() for l in db._run_sqlcipher(db_path, db.preamble(key, db_path) + "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%';\\n", 10).split("\\n") if l.strip().startswith("Msg_")]
    messages = 0
    for n in names:
        sql = 'SELECT count(*) FROM "%s";' % n + "\\n"
        messages += int(db._run_sqlcipher(db_path, db.preamble(key, db_path) + sql, 60).split()[-1])
    print(json.dumps({"ok": True, "tables": tables, "messages": messages}))
except Exception:
    print(json.dumps({"ok": False, "code": "DB_BUSY"}))
`;

export async function verifyKey(opts) {
  const { key, dbPath } = opts;
  const root = opts.root;
  const python = opts.python ?? "python3";
  const queryDir = join(root, "query");

  const out = await new Promise((resolve) => {
    const child = spawn(python, ["-c", SCRIPT, dbPath], {
      cwd: queryDir,
      env: { ...process.env, PYTHONUTF8: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 90_000);
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", () => {});
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
        // detail from a traceback can echo the derived key back; drop it.
        return resolve(parsed.ok ? { ok: true, tables: parsed.tables, messages: parsed.messages } : { ok: false, code: parsed.code });
      } catch {
        return resolve({ ok: false, code: "IO_ERROR" });
      }
    });
    child.stdin.end(key + "\n");
  });

  return out;
}
