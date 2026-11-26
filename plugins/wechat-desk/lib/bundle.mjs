import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeskError } from "./errors.mjs";
import { mergeState, readState } from "./state.mjs";

const run = promisify(execFile);
const REQUIRED_BYTES = 1_500_000_000;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readAppVersion(appPath) {
  try {
    const { stdout } = await run("plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      join(appPath, "Contents/Info.plist"),
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Copy first, sign later: the official bundle is only ever read.
export async function prepareCopy(opts) {
  const root = opts.root;
  const appPath = opts.appPath ?? "/Applications/WeChat.app";
  const emit = opts.onEvent ?? (() => {});
  const target = join(root, "wechat-copy", "WeChat.app");

  const version = await readAppVersion(appPath);
  if (!version) throw new DeskError("APP_COPY_FAILED", { reason: "no version", appPath });

  const state = await readState(root);
  if (state.wechatCopy?.version === version && (await exists(target))) {
    return { copyPath: target, version, copiedAt: state.wechatCopy.copiedAt, reused: true };
  }

  const freeBytes = opts.freeBytes ?? (await statfs(homedir()).then((s) => s.bavail * s.bsize));
  if (freeBytes < REQUIRED_BYTES) throw new DeskError("APP_COPY_FAILED", { reason: "disk", freeBytes });

  emit({ stage: "copy", message: `复制微信 ${version}` });
  await rm(join(root, ".tmp"), { recursive: true, force: true });
  const tmp = join(root, ".tmp", `copy-${randomUUID()}`);
  await mkdir(tmp, { recursive: true });
  try {
    await run("ditto", [appPath, join(tmp, "WeChat.app")], { timeout: 900_000 });
    await mkdir(join(root, "wechat-copy"), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await rename(join(tmp, "WeChat.app"), target);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw new DeskError("APP_COPY_FAILED", { detail: String(err?.message ?? err).slice(0, 300) });
  }
  await rm(tmp, { recursive: true, force: true });

  const copiedAt = Date.now();
  await mergeState(root, { wechatCopy: { version, copiedAt } });
  emit({ stage: "copied", message: "副本就绪" });
  return { copyPath: target, version, copiedAt, reused: false };
}

export async function readCopyVersion(copyPath) {
  return await readAppVersion(copyPath);
}

export async function copyExists(copyPath) {
  return await exists(copyPath);
}

export { readFile };
