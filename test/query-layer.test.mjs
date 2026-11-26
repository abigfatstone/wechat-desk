import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareQuery } from "../lib/query-layer.mjs";
import { makeTemp } from "./helpers.mjs";

export const PINNED_COMMIT = "8a28b83e5d0b73180b915f68f5cc7dc464c26639";

async function fixtureUpstream({ withEntry = true } = {}) {
  const dir = await makeTemp("desk-upstream-");
  if (withEntry) {
    await mkdir(join(dir, "scripts/common"), { recursive: true });
    await writeFile(
      join(dir, "scripts/common/query.py"),
      "import json,sys\nprint(json.dumps({'ok': False, 'code': 'KEY_INVALID'}))\nsys.exit(2)\n",
    );
    await writeFile(join(dir, "config.py"), "SKILL_DIR = '.'\n");
  }
  await writeFile(join(dir, "UPSTREAM_COMMIT"), PINNED_COMMIT + "\n");
  return dir;
}

test("prepareQuery 拷贝上游并写入 BUILD", async () => {
  const root = await makeTemp("desk-root-");
  const r = await prepareQuery({ sourceDir: await fixtureUpstream(), root });

  assert.equal(r.commit, PINNED_COMMIT);
  const build = await readFile(join(r.root, "query", "BUILD"), "utf8");
  assert.match(build, /commit=[0-9a-f]{40}/);
  assert.match(build, /key=key\.txt/);
  assert.match(await readFile(join(r.root, "query", "config.py"), "utf8"), /SKILL_DIR/);
});

test("缺少查询入口时回 NO_QUERY_LAYER", async () => {
  const root = await makeTemp("desk-root-");
  const sourceDir = await fixtureUpstream({ withEntry: false });
  await assert.rejects(
    () => prepareQuery({ sourceDir, root }),
    (err) => err.code === "NO_QUERY_LAYER",
  );
});

test("不复制私有状态文件", async () => {
  const root = await makeTemp("desk-root-");
  const sourceDir = await fixtureUpstream();
  await writeFile(join(sourceDir, "key.txt"), "deadbeef\n");
  await writeFile(join(sourceDir, "all_keys.json"), "{}\n");
  const r = await prepareQuery({ sourceDir, root });
  const listed = await readFile(join(r.root, "query", "BUILD"), "utf8");
  assert.equal(listed.includes("key.txt="), false);
  await assert.rejects(() => readFile(join(r.root, "query", "key.txt")), (e) => e.code === "ENOENT");
  await assert.rejects(() => readFile(join(r.root, "query", "all_keys.json")), (e) => e.code === "ENOENT");
});

test("无 key 时查询入口回结构化错误而不是崩溃", async () => {
  const root = await makeTemp("desk-root-");
  const r = await prepareQuery({ sourceDir: await fixtureUpstream(), root });
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  let out;
  try {
    out = await run("python3", ["scripts/common/query.py", "list", "--json"], { cwd: join(r.root, "query") });
  } catch (err) {
    out = { stdout: err.stdout, stderr: err.stderr };
  }
  const parsed = JSON.parse((out.stdout || out.stderr).trim());
  assert.equal(parsed.code, "KEY_INVALID");
});
