import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { makeTemp } from "./helpers.mjs";

const run = promisify(execFile);
const KEYHOOK = fileURLToPath(new URL("../tools/keyhook.py", import.meta.url));

async function dryRun(root, extra = []) {
  await run("python3", [KEYHOOK, "--app", "/bin/true", "--hook", "/tmp/none.js", "--root", root, "--dry-run", ...extra]);
  return JSON.parse(await readFile(join(root, "keyhook.json"), "utf8"));
}

test("dry-run 依次走完状态机并结束在 captured", async () => {
  const root = await makeTemp("desk-key-");
  const state = await dryRun(root);
  assert.equal(state.phase, "captured");
  assert.equal(typeof state.pid, "number");
});

test("dry-run 不写 key，也不覆盖已有 key", async () => {
  const root = await makeTemp("desk-key-");
  const existing = "cd".repeat(32);
  await writeFile(join(root, "key.txt"), existing + "\n");
  await dryRun(root);
  assert.equal((await readFile(join(root, "key.txt"), "utf8")).trim(), existing);
});

test("状态文件是 0600 且不含 key", async () => {
  const root = await makeTemp("desk-key-");
  await dryRun(root);
  const raw = await readFile(join(root, "keyhook.json"), "utf8");
  assert.equal(/[a-f0-9]{64}/.test(raw), false);
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(join(root, "keyhook.json"))).mode & 0o777, 0o600);
});

test("缺少钩子脚本时回 HOOK_MISSING", async () => {
  const root = await makeTemp("desk-key-");
  const r = await run("python3", [KEYHOOK, "--app", "/bin/true", "--hook", "/tmp/none.js", "--root", root]).catch((e) => e);
  assert.notEqual(r.code, 0);
  const state = JSON.parse(await readFile(join(root, "keyhook.json"), "utf8"));
  assert.equal(state.phase, "failed");
  assert.equal(state.code, "HOOK_MISSING");
});
