import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DeskError } from "./errors.mjs";

const run = promisify(execFile);

// Ad-hoc signing is the only option here: in-place signing of /Applications is
// blocked by App Management, and a re-signed copy that keeps the sandbox
// entitlement is rejected by AMFI. This deliberately drops entitlements.
export async function signCopy(path) {
  try {
    await run("codesign", ["--force", "--deep", "--sign", "-", path], { timeout: 900_000 });
  } catch (err) {
    throw new DeskError("SIGN_FAILED", { stage: "sign", detail: String(err?.stderr ?? err?.message ?? err).slice(0, 300) });
  }

  // codesign -dv writes its description to stderr.
  let info = "";
  try {
    const { stdout, stderr } = await run("codesign", ["-dv", path], { timeout: 60_000 });
    info = `${stdout}${stderr}`;
  } catch (err) {
    info = `${err?.stdout ?? ""}${err?.stderr ?? ""}`;
  }
  if (!/Signature=adhoc/.test(info)) {
    throw new DeskError("SIGN_FAILED", { stage: "verify" });
  }
  return { signature: "adhoc" };
}
