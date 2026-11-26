import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startKeyhook, waitForKey } from "../lib/keyflow.mjs";
import { makeTemp } from "./helpers.mjs";

const KEY = "ef".repeat(32);

function state(root, patch) {
  return writeFile(join(root, "keyhook.json"), JSON.stringify({ phase: "spawning", ...patch }));
}

test("captured 且 key 合法时等待成功", async () => {
  const root = await makeTemp("desk-key-");
  await writeFile(join(root, "key.txt"), KEY + "\n");
  await state(root, { phase: "captured" });
  assert.deepEqual(await waitForKey({ root, timeoutMs: 1000 }), { ok: true });
});

test("captured 但 key 缺失或非法时回 KEY_INVALID", async () => {
  const root = await makeTemp("desk-key-");
  await state(root, { phase: "captured" });
  assert.deepEqual(await waitForKey({ root, timeoutMs: 1000 }), { ok: false, code: "KEY_INVALID" });

  await writeFile(join(root, "key.txt"), "short\n");
  assert.deepEqual(await waitForKey({ root, timeoutMs: 1000 }), { ok: false, code: "KEY_INVALID" });
});

test("failed 状态把错误码透传出来", async () => {
  const root = await makeTemp("desk-key-");
  await state(root, { phase: "failed", code: "LOGIN_TIMEOUT" });
  assert.deepEqual(await waitForKey({ root, timeoutMs: 1000 }), { ok: false, code: "LOGIN_TIMEOUT" });
});

test("一直没有结果时按超时返回", async () => {
  const root = await makeTemp("desk-key-");
  await state(root, { phase: "waiting" });
  const started = Date.now();
  const r = await waitForKey({ root, timeoutMs: 600, pollMs: 100 });
  assert.deepEqual(r, { ok: false, code: "TIMEOUT" });
  assert.ok(Date.now() - started >= 500);
});

test("已有活跃 lock 时 start 复用同一个 pid", async () => {
  const root = await makeTemp("desk-key-");
  await writeFile(join(root, "keyhook.lock"), String(process.pid));
  const r = await startKeyhook({ root, appBin: "/bin/true", hookPath: "/tmp/none.js", python: "python3" });
  assert.equal(r.pid, process.pid);
  assert.equal(r.reused, true);
});

test("死掉的 lock 会被清掉并启动新的守护进程", async () => {
  const root = await makeTemp("desk-key-");
  await writeFile(join(root, "keyhook.lock"), "999999");
  const r = await startKeyhook({
    root,
    appBin: "/bin/true",
    hookPath: "/tmp/none.js",
    python: "python3",
    dryRun: true,
  });
  assert.equal(r.reused, false);
  assert.notEqual(r.pid, 999999);
  const lock = await readFile(join(root, "keyhook.lock"), "utf8");
  assert.equal(lock.trim(), String(r.pid));
});
