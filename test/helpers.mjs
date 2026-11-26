import { randomBytes, pbkdf2Sync } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeApp(version) {
  const dir = await mkdtemp(join(tmpdir(), "desk-app-"));
  const app = join(dir, "WeChat.app");
  await mkdir(join(app, "Contents"), { recursive: true });
  await writeFile(
    join(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>
`,
  );
  return app;
}

export async function makeData({ shards = 1, account = "acct" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "desk-data-"));
  const dir = join(root, "xwechat_files", account, "db_storage", "message");
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < shards; i++) {
    await writeFile(join(dir, `message_${i}.db`), Buffer.alloc(16, i));
  }
  return root;
}

export async function makeTemp(prefix = "desk-") {
  return mkdtemp(join(tmpdir(), prefix));
}

// WeChat encrypts with sqlite3_key(raw_bytes), so the per-database key is
// PBKDF2-HMAC-SHA512(raw, file-salt, 256000). Fixtures must therefore pin the
// salt, compute the derived key ourselves, and open with kdf_iter=1 — the same
// path upstream derive_key() takes.
export async function makeSyntheticDb({ messages = 3, rawKey = "11".repeat(32) } = {}) {
  const dir = await makeTemp("desk-db-");
  const dbPath = join(dir, "message_0.db");
  const raw = Buffer.from(rawKey, "hex");
  const salt = randomBytes(16);
  const derived = pbkdf2Sync(raw, salt, 256000, 32, "sha512").toString("hex");
  const inserts = Array.from({ length: messages }, (_, i) => `INSERT INTO Msg_1 VALUES (${i});`).join("\n");
  const sql = [
    `PRAGMA key = "x'${derived}'";`,
    `PRAGMA cipher_salt = "x'${salt.toString("hex")}'";`,
    "PRAGMA kdf_iter = 1;",
    "PRAGMA cipher_compatibility = 4;",
    "CREATE TABLE Msg_1(id INTEGER);",
    inserts,
    "",
  ].join("\n");
  await new Promise((resolve, reject) => {
    const child = spawn("sqlcipher", [dbPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr || `sqlcipher exit ${code}`))));
    child.stdin.end(sql);
  });
  return { dbPath, key: rawKey };
}
