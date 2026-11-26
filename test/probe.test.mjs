import test from "node:test";
import assert from "node:assert/strict";
import { probe } from "../lib/probe.mjs";
import { makeApp, makeData } from "./helpers.mjs";

test("不支持版本标记 supported=false 但仍返回 dbs", async () => {
  const p = await probe({ appPath: await makeApp("4.1.0"), dataRoot: await makeData() });
  assert.equal(p.wechat.supported, false);
  assert.equal(p.wechat.dbs.length, 1);
  assert.match(p.wechat.version, /^4\.1\.0$/);
});

test("支持矩阵内的版本标记 supported=true", async () => {
  const p = await probe({ appPath: await makeApp("4.2.0"), dataRoot: await makeData({ shards: 3 }) });
  assert.equal(p.wechat.supported, true);
  assert.equal(p.wechat.dbs.length, 3);
});

test("微信不存在时 wechat 为 null 而不抛错", async () => {
  const p = await probe({ appPath: "/nonexistent/WeChat.app", dataRoot: "/nonexistent" });
  assert.equal(p.wechat, null);
});

test("磁盘不足时 disk.ok=false", async () => {
  const p = await probe({ freeBytes: 1000 });
  assert.equal(p.disk.ok, false);
  assert.equal(p.disk.requiredBytes, 2_500_000_000);
});

test("只取最近修改账号的库，不混入旧账号", async () => {
  const dataRoot = await makeData({ account: "acct-old", shards: 2 });
  const { mkdir, writeFile, utimes } = await import("node:fs/promises");
  const fresh = `${dataRoot}/xwechat_files/acct-new/db_storage/message`;
  await mkdir(fresh, { recursive: true });
  await writeFile(`${fresh}/message_0.db`, Buffer.alloc(16, 9));
  const now = new Date();
  await utimes(`${fresh}/message_0.db`, now, now);
  const p = await probe({ dataRoot });
  assert.deepEqual(
    p.wechat.dbs.map((d) => d.path.endsWith("/acct-new/db_storage/message/message_0.db")),
    [true],
  );
});
