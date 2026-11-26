import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildPlugin } from "../scripts/build-plugin.mjs";

const run = promisify(execFile);
const PLUGIN = fileURLToPath(new URL("../plugins/wechat-desk", import.meta.url));

test("构建后插件自带全部依赖模块", async () => {
  await buildPlugin();
  for (const rel of ["zero.mjs", "lib/query.mjs", "lib/bridge.mjs", "lib/ilink.mjs", "lib/keyflow.mjs", "bin/wechatdesk.mjs", "tools/keyhook.py"]) {
    assert.equal((await stat(join(PLUGIN, rel))).isFile(), true, rel);
  }
});

test("插件入口能被加载（不启动服务）", async () => {
  const mod = await import(join(PLUGIN, "zero.mjs"));
  assert.equal(mod.default.id, "wechat-desk");
  assert.equal(typeof mod.default.setup, "function");
});

test("复制进来的模块语法都能通过 node --check", async () => {
  const { readdir } = await import("node:fs/promises");
  for (const file of await readdir(join(PLUGIN, "lib"))) {
    if (!file.endsWith(".mjs")) continue;
    await run(process.execPath, ["--check", join(PLUGIN, "lib", file)]);
  }
});

test("BUILD 记录模块数量", async () => {
  const { modules } = await buildPlugin();
  const build = JSON.parse(await readFile(join(PLUGIN, "BUILD"), "utf8"));
  assert.equal(build.modules, modules);
  assert.ok(modules >= 8);
});
