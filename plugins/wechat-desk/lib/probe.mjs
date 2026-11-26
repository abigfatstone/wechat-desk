import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { mergeState } from "./state.mjs";
import { join } from "node:path";

const run = promisify(execFile);

export const SUPPORTED_WECHAT = /^4\.2\./;
export const REQUIRED_DISK_BYTES = 2_500_000_000; // 副本 1.4 GB + 运行时 0.2 GB + 余量
const DEFAULT_APP = "/Applications/WeChat.app";
const DEFAULT_DATA = join(
  homedir(),
  "Library/Containers/com.tencent.xinWeChat/Data/Documents",
);

async function version(appPath) {
  try {
    const plist = join(appPath, "Contents/Info.plist");
    const { stdout } = await run("plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      plist,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Only the account directory touched most recently is real; older ones are
// leftovers from a previous install and would double-count message shards.
async function newestAccount(dataRoot) {
  try {
    const base = join(dataRoot, "xwechat_files");
    const names = await readdir(base, { withFileTypes: true });
    let best = null;
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const path = join(base, entry.name);
      const mtime = (await stat(path)).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

async function shards(account) {
  const dir = join(account, "db_storage", "message");
  try {
    const names = await readdir(dir);
    const dbs = [];
    for (const name of names.filter((n) => /^message_\d+\.db$/.test(n)).sort()) {
      dbs.push({ path: join(dir, name), size: (await stat(join(dir, name))).size });
    }
    return dbs;
  } catch {
    return [];
  }
}

async function which(bin) {
  try {
    const { stdout } = await run("which", [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function pythonVersion() {
  try {
    const { stdout } = await run("python3", ["--version"]);
    const m = stdout.match(/(\d+)\.(\d+)/);
    return m ? `${m[1]}.${m[2]}` : null;
  } catch {
    return null;
  }
}

export async function probe(opts = {}) {
  const appPath = opts.appPath ?? DEFAULT_APP;
  const dataRoot = opts.dataRoot ?? DEFAULT_DATA;

  const freeBytes =
    opts.freeBytes ??
    (await statfs(homedir()).then((s) => s.bavail * s.bsize));

  let wechat = null;
  const v = await version(appPath);
  if (v !== null) {
    const account = await newestAccount(dataRoot);
    wechat = {
      version: v,
      appPath,
      supported: SUPPORTED_WECHAT.test(v),
      dbs: account ? await shards(account) : [],
    };
  }

  let macos = null;
  try {
    const { stdout } = await run("sw_vers", ["-productVersion"]);
    macos = stdout.trim() || null;
  } catch {
    macos = null;
  }

  const py = await pythonVersion();
  const major = py ? Number(py.split(".")[0]) : 0;
  const minor = py ? Number(py.split(".")[1]) : 0;

  const result = {
    arch: process.arch,
    macos,
    disk: { freeBytes, requiredBytes: REQUIRED_DISK_BYTES, ok: freeBytes >= REQUIRED_DISK_BYTES },
    wechat,
    deps: {
      sqlcipher: await which("sqlcipher"),
      python: major > 3 || (major === 3 && minor >= 10) ? py : null,
      brew: Boolean(await which("brew")),
    },
  };

  // Later steps must be able to answer "is this WeChat version supported?"
  // without re-probing, so the verdict is durable, not just in the return value.
  if (opts.root && wechat) {
    await mergeState(opts.root, { wechat: { version: wechat.version, supported: wechat.supported } });
  }

  return result;
}
