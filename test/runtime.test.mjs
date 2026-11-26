import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntime } from "../lib/runtime.mjs";
import { makeTemp } from "./helpers.mjs";

const run = promisify(execFile);
const sha = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

async function offlineFixture({ brokenPython = false, emptyPython = false } = {}) {
  const dir = await makeTemp("desk-offline-");
  const work = await makeTemp("desk-py-");
  if (emptyPython) {
    await mkdir(join(work, "python"), { recursive: true });
    await writeFile(join(work, "python/README"), "no interpreter here\n");
  } else {
    await mkdir(join(work, "python/bin"), { recursive: true });
    await writeFile(join(work, "python/bin/python3"), "#!/bin/sh\necho 'Python 3.12.0'\n");
    await chmod(join(work, "python/bin/python3"), 0o755);
  }
  const tarball = join(dir, "python-arm64.tar.gz");
  await run("tar", ["-czf", tarball, "-C", work, "python"]);

  const sqlcipher = join(dir, "sqlcipher-arm64");
  await writeFile(sqlcipher, "#!/bin/sh\necho 'sqlcipher 4.20.0'\n");
  await chmod(sqlcipher, 0o755);

  const manifest = {
    version: "3.12.0",
    python: { name: "python-arm64.tar.gz", sha256: brokenPython ? "0".repeat(64) : await sha(tarball) },
    sqlcipher: { name: "sqlcipher-arm64", sha256: await sha(sqlcipher) },
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

test("首次准备产出 python 与 sqlcipher，第二次复用不重复取件", async () => {
  const root = await makeTemp("desk-root-");
  const offlineDir = await offlineFixture();
  const events = [];
  const first = await prepareRuntime({ root, offlineDir, onEvent: (e) => events.push(e) });

  assert.equal(first.version, "3.12.0");
  assert.equal(await stat(first.python).then((s) => s.isFile()), true);
  assert.equal(await stat(first.sqlcipher).then((s) => s.isFile()), true);
  assert.ok(events.some((e) => e.stage === "fetch"));

  const again = [];
  const second = await prepareRuntime({ root, offlineDir, onEvent: (e) => again.push(e) });
  assert.equal(second.python, first.python);
  assert.equal(again.filter((e) => e.stage === "fetch").length, 0);
});

test("校验失败时不留下半个运行时", async () => {
  const root = await makeTemp("desk-root-");
  const offlineDir = await offlineFixture({ brokenPython: true });
  await assert.rejects(
    () => prepareRuntime({ root, offlineDir }),
    (err) => err.code === "NO_RUNTIME",
  );
  await assert.rejects(() => stat(join(root, "runtime", "3.12.0")), (e) => e.code === "ENOENT");
});

test("产物里没有 python 时回 NO_RUNTIME，而不是假装就绪", async () => {
  const root = await makeTemp("desk-root-");
  const offlineDir = await offlineFixture({ emptyPython: true });
  await assert.rejects(
    () => prepareRuntime({ root, offlineDir }),
    (err) => err.code === "NO_RUNTIME",
  );
  const { readState } = await import("../lib/state.mjs");
  const state = await readState(root);
  assert.equal(state.runtime.phase, "failed");
});

test("成功准备会清掉遗留的 .tmp 目录", async () => {
  const root = await makeTemp("desk-root-");
  await mkdir(join(root, ".tmp", "stale"), { recursive: true });
  await writeFile(join(root, ".tmp", "stale", "leftover"), "x");
  await prepareRuntime({ root, offlineDir: await offlineFixture() });
  await assert.rejects(() => stat(join(root, ".tmp", "stale")), (e) => e.code === "ENOENT");
});

test("校验失败时 state 记录 failed 与错误码", async () => {
  const root = await makeTemp("desk-root-");
  const offlineDir = await offlineFixture({ brokenPython: true });
  await assert.rejects(() => prepareRuntime({ root, offlineDir }));
  const { readState } = await import("../lib/state.mjs");
  const state = await readState(root);
  assert.equal(state.runtime.phase, "failed");
  assert.equal(state.runtime.code, "NO_RUNTIME");
});
