import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FILE = "binding.json";

export async function loadBinding(root) {
  try {
    const data = JSON.parse(await readFile(join(root, FILE), "utf8"));
    if (!data?.base || !data?.user || !data?.bot || !data?.token) return null;
    return data;
  } catch {
    return null;
  }
}

export async function saveBinding(root, binding) {
  const path = join(root, FILE);
  const tmp = join(root, `.binding.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify({ ...binding, boundAt: Date.now() }, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
  return path;
}

// Anything shown to a user or a log goes through here: the token is a bearer
// credential for the user's own WeChat identity.
export function publicBinding(binding) {
  if (!binding) return null;
  return { base: binding.base, user: binding.user, bot: binding.bot, boundAt: binding.boundAt ?? null, hasToken: Boolean(binding.token) };
}
