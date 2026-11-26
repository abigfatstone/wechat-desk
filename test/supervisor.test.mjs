import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { launchAgentPlist, installAgent, uninstallAgent } from "../lib/supervisor.mjs";
import { makeTemp } from "./helpers.mjs";

const OPTS = {
  label: "cn.zero.wechatdesk",
  program: "/usr/bin/node",
  args: ["/repo/bin/wechatdesk.mjs", "serve"],
  root: "/tmp/desk-root",
};

test("plist 开启 RunAtLoad 与 KeepAlive 并带参数", () => {
  const xml = launchAgentPlist(OPTS);
  assert.match(xml, /<string>cn\.zero\.wechatdesk<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<string>\/usr\/bin\/node<\/string>/);
  assert.match(xml, /<string>\/repo\/bin\/wechatdesk\.mjs<\/string>/);
  assert.match(xml, /\/tmp\/desk-root\/logs\/agent\.log/);
});

test("plist 转义 XML 特殊字符", () => {
  const xml = launchAgentPlist({ ...OPTS, root: "/tmp/a&b" });
  assert.match(xml, /a&amp;b/);
  assert.equal(xml.includes("a&b"), false);
});

test("install 写出 plist 并返回路径，uninstall 删除", async () => {
  const dir = await makeTemp("desk-agents-");
  const r = await installAgent({ ...OPTS, agentsDir: dir, load: false });
  assert.equal(r.path, join(dir, "cn.zero.wechatdesk.plist"));
  assert.equal((await stat(r.path)).isFile(), true);
  await uninstallAgent({ label: OPTS.label, agentsDir: dir, load: false });
  await assert.rejects(() => stat(r.path), (e) => e.code === "ENOENT");
});

test("install 内容与 launchAgentPlist 一致", async () => {
  const dir = await makeTemp("desk-agents-");
  const r = await installAgent({ ...OPTS, agentsDir: dir, load: false });
  assert.equal(await readFile(r.path, "utf8"), launchAgentPlist(OPTS));
});
