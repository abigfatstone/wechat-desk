import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const FILE = "state.json";

export async function readState(root) {
  try {
    return JSON.parse(await readFile(join(root, FILE), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

// Top-level merge only: nested objects are replaced whole, so callers never
// have to reason about half-merged sub-trees.
export async function mergeState(root, patch) {
  const next = { ...(await readState(root)), ...patch };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const tmp = join(root, `.state.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
    await rename(tmp, join(root, FILE));
  } finally {
    await rm(tmp, { force: true });
  }
  return next;
}
