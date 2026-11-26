import test from "node:test";
import assert from "node:assert/strict";
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { saveBinding, loadBinding, publicBinding } from "../lib/binding.mjs";
import { makeTemp } from "./helpers.mjs";

const B = { base: "https://ilinkai.weixin.qq.com", user: "u1", bot: "b1", token: "secret-token" };

test("保存后能读回，权限 0600", async () => {
  const root = await makeTemp("desk-bind-");
  await saveBinding(root, B);
  const loaded = await loadBinding(root);
  assert.equal(loaded.token, B.token);
  assert.equal(loaded.user, B.user);
  assert.equal(loaded.bot, B.bot);
  assert.equal(typeof loaded.boundAt, "number");
  assert.equal((await stat(join(root, "binding.json"))).mode & 0o777, 0o600);
});

test("对外状态不含 token", async () => {
  const root = await makeTemp("desk-bind-");
  await saveBinding(root, B);
  const pub = publicBinding(await loadBinding(root));
  assert.equal(JSON.stringify(pub).includes("secret-token"), false);
  assert.equal(pub.user, "u1");
});

test("没有绑定时 loadBinding 返回 null", async () => {
  assert.equal(await loadBinding(await makeTemp("desk-bind-")), null);
});

test("损坏的 binding.json 不抛异常，按未绑定处理", async () => {
  const root = await makeTemp("desk-bind-");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "binding.json"), "{not json");
  assert.equal(await loadBinding(root), null);
  assert.equal((await readFile(join(root, "binding.json"), "utf8")).startsWith("{not"), true);
});
