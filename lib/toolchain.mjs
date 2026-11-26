import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readState } from "./state.mjs";

async function isExecutable(path) {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

// A prepared runtime exists precisely so the product does not depend on what
// the machine already had. Use it when it is there; fall back only when not.
export async function resolveToolchain(root, opts = {}) {
  const state = await readState(root);
  const version = state.runtime?.version ?? null;

  let python = opts.python ?? null;
  let sqlcipher = null;

  if (version) {
    const candidatePython = join(root, "runtime", version, "python", "bin", "python3");
    if (!python && (await isExecutable(candidatePython))) python = candidatePython;
    const candidateSqlcipher = join(root, "runtime", version, "bin", "sqlcipher");
    if (await isExecutable(candidateSqlcipher)) sqlcipher = candidateSqlcipher;
  }

  const env = { ...process.env, PYTHONUTF8: "1" };
  if (sqlcipher) env.WECHAT_SQLCIPHER_PATH = sqlcipher;

  return { python: python ?? "python3", env, version, sqlcipher };
}

export async function assertSupportedWechat(root) {
  const state = await readState(root);
  if (state.wechat && state.wechat.supported === false) return state.wechat;
  return null;
}
