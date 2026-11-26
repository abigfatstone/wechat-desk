import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareCopy } from "../lib/bundle.mjs";
import { makeApp, makeTemp } from "./helpers.mjs";

test("prepareCopy 复制到 <root>/wechat-copy 并记录版本", async () => {
  const root = await makeTemp("desk-root-");
  const appPath = await makeApp("4.2.0");
  const events = [];
  const r = await prepareCopy({ root, appPath, onEvent: (e) => events.push(e) });

  assert.equal(r.version, "4.2.0");
  assert.equal(r.copyPath, join(root, "wechat-copy", "WeChat.app"));
  assert.deepEqual(await readdir(r.copyPath), ["Contents"]);
  assert.ok(events.some((e) => e.stage === "copy"));
});

test("同版本再次调用复用副本，不重复复制", async () => {
  const root = await makeTemp("desk-root-");
  const appPath = await makeApp("4.2.0");
  await prepareCopy({ root, appPath });
  const again = [];
  await prepareCopy({ root, appPath, onEvent: (e) => again.push(e) });
  assert.equal(again.filter((e) => e.stage === "copy").length, 0);
});

test("版本变化时重新复制", async () => {
  const root = await makeTemp("desk-root-");
  await prepareCopy({ root, appPath: await makeApp("4.2.0") });
  const events = [];
  await prepareCopy({ root, appPath: await makeApp("4.3.0"), onEvent: (e) => events.push(e) });
  assert.ok(events.some((e) => e.stage === "copy"));
});

test("磁盘不足时回 APP_COPY_FAILED 且不留半份副本", async () => {
  const root = await makeTemp("desk-root-");
  const appPath = await makeApp("4.2.0");
  await assert.rejects(
    () => prepareCopy({ root, appPath, freeBytes: 1000 }),
    (err) => err.code === "APP_COPY_FAILED",
  );
  await assert.rejects(() => readdir(join(root, "wechat-copy")), (e) => e.code === "ENOENT");
});

test("源 app 不存在时回 APP_COPY_FAILED", async () => {
  const root = await makeTemp("desk-root-");
  await assert.rejects(
    () => prepareCopy({ root, appPath: "/nonexistent/WeChat.app" }),
    (err) => err.code === "APP_COPY_FAILED",
  );
});
