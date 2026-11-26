import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, mergeState } from "../lib/state.mjs";
import { DeskError } from "../lib/errors.mjs";

const root = () => mkdtemp(join(tmpdir(), "desk-"));

test("mergeState 原子写且权限 0600", async () => {
  const dir = await root();
  await mergeState(dir, { runtime: { version: "1.0.0" } });
  const mode = (await stat(join(dir, "state.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal((await readState(dir)).runtime.version, "1.0.0");
});

test("mergeState 保留未提及的顶层键", async () => {
  const dir = await root();
  await mergeState(dir, { runtime: { version: "1.0.0" } });
  await mergeState(dir, { key: { ok: true } });
  const state = await readState(dir);
  assert.equal(state.runtime.version, "1.0.0");
  assert.equal(state.key.ok, true);
});

test("readState 在文件缺失时返回空对象", async () => {
  assert.deepEqual(await readState(await root()), {});
});

test("DeskError 携带稳定 code", () => {
  const err = new DeskError("KEY_INVALID", { db: "message_0.db" });
  assert.equal(err.code, "KEY_INVALID");
  assert.equal(err.name, "DeskError");
  assert.deepEqual(err.detail, { db: "message_0.db" });
});
