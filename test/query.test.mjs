import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { queryOnce } from "../lib/query.mjs";
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
