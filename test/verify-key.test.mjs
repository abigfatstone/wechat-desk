import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { prepareQuery } from "../lib/query-layer.mjs";
import { verifyKey } from "../lib/verify-key.mjs";
import { makeSyntheticDb, makeTemp } from "./helpers.mjs";

const PINNED_COMMIT = "8a28b83e5d0b73180b915f68f5cc7dc464c26639";

async function preparedRoot() {
  const root = await makeTemp("desk-root-");
  await prepareQuery({
    sourceDir: new URL("../vendor/wechat-decrypt", import.meta.url).pathname,
    root,
    commit: PINNED_COMMIT,
  });
  return root;
}

test("正确 key 返回表与消息数量", async () => {
  const root = await preparedRoot();
  const { dbPath, key } = await makeSyntheticDb({ messages: 3 });
  const r = await verifyKey({ root, key, dbPath });
  assert.equal(r.ok, true);
  assert.ok(r.tables > 0, `tables=${r.tables}`);
  assert.equal(r.messages, 3);
});

test("错误 key 返回 KEY_INVALID 而不是抛异常", async () => {
  const root = await preparedRoot();
  const { dbPath } = await makeSyntheticDb();
  const r = await verifyKey({ root, key: "00".repeat(32), dbPath });
  assert.deepEqual(r, { ok: false, code: "KEY_INVALID" });
});

test("错误 key 不出现在返回值里", async () => {
  const root = await preparedRoot();
  const { dbPath } = await makeSyntheticDb();
  const bad = "ab".repeat(32);
  const r = await verifyKey({ root, key: bad, dbPath });
  assert.equal(JSON.stringify(r).includes(bad), false);
  assert.equal(JSON.stringify(r).includes(bad.slice(0, 8)), false);
});

test("库文件不存在时回 IO_ERROR", async () => {
  const root = await preparedRoot();
  const r = await verifyKey({ root, key: "11".repeat(32), dbPath: join(root, "nope.db") });
  assert.deepEqual(r, { ok: false, code: "IO_ERROR" });
});

test("库被独占锁定时回 DB_BUSY，而不是 KEY_INVALID", async () => {
  const root = await preparedRoot();
  const { dbPath, key, openSql } = await makeSyntheticDb();
  const holder = spawn("sqlcipher", [dbPath], { stdio: ["pipe", "ignore", "ignore"] });
  holder.stdin.write(openSql + "BEGIN EXCLUSIVE;\n");
  await new Promise((r) => setTimeout(r, 600));
  try {
    const r = await verifyKey({ root, key, dbPath, timeoutMs: 5000 });
    assert.deepEqual(r, { ok: false, code: "DB_BUSY" });
  } finally {
    holder.kill("SIGKILL");
  }
});

test("state 记录微信版本不支持时直接回 UNSUPPORTED_WECHAT", async () => {
  const root = await preparedRoot();
  const { mergeState } = await import("../lib/state.mjs");
  await mergeState(root, { wechat: { version: "4.1.0", supported: false } });
  const { dbPath, key } = await makeSyntheticDb();
  assert.deepEqual(await verifyKey({ root, key, dbPath }), { ok: false, code: "UNSUPPORTED_WECHAT" });
});
