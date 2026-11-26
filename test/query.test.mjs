import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { queryOnce } from "../lib/query.mjs";
import { mergeState } from "../lib/state.mjs";
import { makeTemp } from "./helpers.mjs";

async function stubRoot(script) {
  const root = await makeTemp("desk-root-");
  await mkdir(join(root, "query", "scripts", "common"), { recursive: true });
  await writeFile(join(root, "query", "scripts", "common", "query.py"), script);
  return root;
}

const ECHO = `import json, sys
print(json.dumps({"ok": True, "argv": sys.argv[1:]}, ensure_ascii=False))
`;

test("op 白名单之外返回 BAD_ARGS", async () => {
  const root = await stubRoot(ECHO);
  assert.deepEqual(await queryOnce({ root, op: "drop" }), { ok: false, code: "BAD_ARGS" });
});

test("中文与 emoji 原样往返，值前有 -- 保护", async () => {
  const root = await stubRoot(ECHO);
  const r = await queryOnce({ root, op: "search", value: "截止🐙 --limit 999" });
  assert.equal(r.ok, true);
  assert.ok(r.data.argv.includes("截止🐙 --limit 999"));
  assert.equal(r.data.argv[r.data.argv.indexOf("截止🐙 --limit 999") - 1], "--");
});

test("超长 value 被拒而不是截断后查询", async () => {
  const root = await stubRoot(ECHO);
  assert.deepEqual(await queryOnce({ root, op: "search", value: "x".repeat(181) }), {
    ok: false,
    code: "BAD_ARGS",
  });
});

test("read/search 缺少 value 返回 BAD_ARGS", async () => {
  const root = await stubRoot(ECHO);
  assert.deepEqual(await queryOnce({ root, op: "read" }), { ok: false, code: "BAD_ARGS" });
});

test("days/limit 越界返回 BAD_ARGS", async () => {
  const root = await stubRoot(ECHO);
  assert.deepEqual(await queryOnce({ root, op: "recent", days: 0 }), { ok: false, code: "BAD_ARGS" });
  assert.deepEqual(await queryOnce({ root, op: "recent", limit: 101 }), { ok: false, code: "BAD_ARGS" });
});

test("上游缺少 key 时映射为 KEY_INVALID", async () => {
  const root = await stubRoot(`import sys
print("FileNotFoundError: 密钥文件不存在: key.txt", file=sys.stderr)
sys.exit(1)
`);
  assert.deepEqual(await queryOnce({ root, op: "list" }), { ok: false, code: "KEY_INVALID" });
});

test("超时映射为 TIMEOUT", async () => {
  const root = await stubRoot("import time\ntime.sleep(5)\n");
  const r = await queryOnce({ root, op: "list", timeoutMs: 100 });
  assert.deepEqual(r, { ok: false, code: "TIMEOUT" });
});

test("非 JSON 输出映射为 IO_ERROR", async () => {
  const root = await stubRoot(`print("not json")\n`);
  assert.deepEqual(await queryOnce({ root, op: "list" }), { ok: false, code: "IO_ERROR" });
});

test("大段中文跨 chunk 不被截断成乱码", async () => {
  const payload = "截止🐙交付日期".repeat(20000);
  const root = await stubRoot(`import json, sys
print(json.dumps({"ok": True, "text": ${JSON.stringify(payload)}}, ensure_ascii=False))
`);
  const r = await queryOnce({ root, op: "list" });
  assert.equal(r.ok, true);
  assert.equal(r.data.text.length, payload.length);
  assert.equal(r.data.text.includes("\uFFFD"), false);
});

test("有运行时就用运行时 python 与 sqlcipher，而不是 PATH", async () => {
  const root = await makeTemp("desk-root-");
  const v = "9.9.9";
  await mkdir(join(root, "runtime", v, "python", "bin"), { recursive: true });
  await mkdir(join(root, "runtime", v, "bin"), { recursive: true });
  await mkdir(join(root, "query"), { recursive: true });
  await writeFile(join(root, "runtime", v, "bin", "sqlcipher"), "#!/bin/sh\n");
  const py = join(root, "runtime", v, "python", "bin", "python3");
  await writeFile(py, `#!/bin/sh\nprintf '{"ok":true,"sqlcipher":"%s","self":"%s"}' "$WECHAT_SQLCIPHER_PATH" "$0"\n`);
  await chmod(py, 0o755);
  await mergeState(root, { runtime: { version: v } });

  const r = await queryOnce({ root, op: "list" });
  assert.equal(r.ok, true);
  assert.equal(r.data.self, py);
  assert.equal(r.data.sqlcipher, join(root, "runtime", v, "bin", "sqlcipher"));
});

test("state 记录微信版本不支持时直接回 UNSUPPORTED_WECHAT", async () => {
  const root = await stubRoot(ECHO);
  await mergeState(root, { wechat: { version: "4.1.0", supported: false } });
  assert.deepEqual(await queryOnce({ root, op: "list" }), { ok: false, code: "UNSUPPORTED_WECHAT" });
});

test("list 支持 offset 翻页", async () => {
  const root = await stubRoot(ECHO);
  const r = await queryOnce({ root, op: "list", offset: 500 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.argv.slice(-2), ["--offset", "500"]);
});

test("offset 为负数时拒绝", async () => {
  const root = await stubRoot(ECHO);
  assert.deepEqual(await queryOnce({ root, op: "list", offset: -1 }), { ok: false, code: "BAD_ARGS" });
});
