import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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

// "Runs" means: either it produced JSON, or it failed the way a keyless layer
// fails. A syntax error or a missing module means the copy is unusable, and
// saying so now beats an IO_ERROR three steps later.
function runsWithoutKey({ code, stdout, stderr }) {
  try {
    const parsed = JSON.parse(stdout.trim());
    if (parsed && typeof parsed === "object") return true;
  } catch {
    /* fall through to the stderr check */
  }
  return /密钥文件不存在|密钥格式无效/.test(stderr);
}

async function smoke(target, python) {
  return await new Promise((resolve) => {
    const child = spawn(python, ["scripts/common/query.py", "list", "--json"], {
      cwd: target,
      env: { ...process.env, PYTHONUTF8: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (b) => (stdout += b));
    child.stderr.setEncoding("utf8").on("data", (b) => (stderr += b));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: "spawn failed" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
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

  // The key lives above the versioned tree: re-running this step must never
  // destroy what the user paid a WeChat re-login to obtain.
  await mkdir(root, { recursive: true });
  await symlink(join(root, "key.txt"), join(target, "key.txt")).catch(async (err) => {
    if (err.code !== "EEXIST") throw err;
  });

  const outcome = await smoke(target, opts.python ?? "python3");
  if (!runsWithoutKey(outcome)) {
    throw new DeskError("NO_QUERY_LAYER", { reason: "smoke", stderr: outcome.stderr.slice(0, 300) });
  }

  const sha256 = await dirHash(target);
  const build = `commit=${commit}\nkey=key.txt\nhash=${sha256}\n`;
  await writeFile(join(target, "BUILD"), build, { mode: 0o644 });

  return { root, commit, sha256 };
}
