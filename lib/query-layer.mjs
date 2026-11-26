import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { DeskError } from "./errors.mjs";

const EXCLUDE = new Set([
  ".git",
  ".venv",
  "__pycache__",
  "decrypted",
  "key.txt",
  "key_windows.txt",
  "all_keys.json",
  "contacts.json",
  ".DS_Store",
]);

async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, base, out);
    else if (entry.isFile()) out.push(relative(base, path));
  }
  return out.sort();
}

async function dirHash(dir) {
  const hash = createHash("sha256");
  for (const rel of await walk(dir)) {
    const fileHash = createHash("sha256").update(await readFile(join(dir, rel))).digest("hex");
    hash.update(`${rel}:${fileHash}\n`);
  }
  return hash.digest("hex");
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function prepareQuery(opts) {
  const { sourceDir } = opts;
  const root = opts.root ?? join(process.env.HOME ?? ".", "Library/Application Support/WeChatDesk");
  const entry = join(sourceDir, "scripts", "common", "query.py");

  if (!(await isFile(entry))) throw new DeskError("NO_QUERY_LAYER", { reason: "entry", sourceDir });

  let commit = opts.commit;
  if (!commit) {
    try {
      commit = (await readFile(join(sourceDir, "UPSTREAM_COMMIT"), "utf8")).trim();
    } catch {
      commit = "";
    }
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new DeskError("NO_QUERY_LAYER", { reason: "commit", sourceDir });
  }

  const target = join(root, "query");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(sourceDir, target, {
    recursive: true,
    filter: (src) => !EXCLUDE.has(basename(src)),
  });

  const sha256 = await dirHash(target);
  const build = `commit=${commit}\nkey=key.txt\nhash=${sha256}\n`;
  await writeFile(join(target, "BUILD"), build, { mode: 0o644 });

  return { root, commit, sha256 };
}
