import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { signCopy } from "../lib/sign.mjs";
import { makeTemp } from "./helpers.mjs";

const run = promisify(execFile);

async function stubBinary() {
  const dir = await makeTemp("desk-bin-");
  const src = join(dir, "main.c");
  const out = join(dir, "stub");
  await writeFile(src, "int main(void){return 0;}\n");
  await run("clang", [src, "-o", out]);
  return out;
}

test("签名后 codesign 报告 adhoc", async () => {
  const bin = await stubBinary();
  const r = await signCopy(bin);
  assert.equal(r.signature, "adhoc");

  const { stdout, stderr } = await run("codesign", ["-dv", bin]).catch((e) => e);
  assert.match(`${stdout}${stderr}`, /Signature=adhoc/);
});

test("目标不存在时回 SIGN_FAILED", async () => {
  await assert.rejects(() => signCopy("/nonexistent/binary"), (err) => err.code === "SIGN_FAILED");
});
