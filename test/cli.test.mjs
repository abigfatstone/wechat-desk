import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { makeTemp } from "./helpers.mjs";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/wechatdesk.mjs", import.meta.url));

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("失败也把结构化 JSON 写到 stdout", async () => {
  const r = await cli(["nope"]);
  assert.equal(r.code, 2);
  assert.deepEqual(JSON.parse(r.stdout).code, "BAD_ARGS");
});

test("拒绝 --key，避免密钥进入进程列表", async () => {
  const r = await cli(["verify-key", "--root", await makeTemp(), "--db", "/tmp/x.db", "--key", "ab".repeat(32)]);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).code, "BAD_ARGS");
});

test("未知参数被拒绝而不是静默忽略", async () => {
  const r = await cli(["probe", "--nope", "x"]);
  assert.equal(r.code, 2);
});

test("probe --json 这种开关参数不被误判缺少取值", async () => {
  const r = await cli(["probe", "--json"]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

test("query 参数非法时退出码与 BAD_ARGS 一致", async () => {
  const r = await cli(["query", "drop", "--root", await makeTemp()]);
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.stdout).code, "BAD_ARGS");
});
