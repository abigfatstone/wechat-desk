import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DeskError } from "./errors.mjs";
import { mergeState, readState } from "./state.mjs";

const run = promisify(execFile);

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// The runtime is only ever assembled from a local artifact directory. Fetching
// is the agent playbook's job: it can retry, mirror, or reuse what is present,
// none of which belongs in a deterministic step.
export async function prepareRuntime(opts = {}) {
  const root = opts.root ?? join(process.env.HOME ?? ".", "Library/Application Support/WeChatDesk");
  const offlineDir = opts.offlineDir;
  const emit = opts.onEvent ?? (() => {});

  if (!offlineDir) throw new DeskError("NO_RUNTIME", { reason: "offlineDir required" });

  const manifest = JSON.parse(await readFile(join(offlineDir, "manifest.json"), "utf8"));
  const version = manifest.version;
  const target = join(root, "runtime", version);

  const state = await readState(root);
  if (state.runtime?.version === version && (await exists(target))) {
    return {
      root,
      version,
      python: join(target, "python", "bin", "python3"),
      sqlcipher: join(target, "bin", "sqlcipher"),
    };
  }

  const pythonTarball = join(offlineDir, manifest.python.name);
  const sqlcipherArtifact = join(offlineDir, manifest.sqlcipher.name);

  emit({ stage: "fetch", message: "校验运行时产物" });
  for (const [path, expected] of [
    [pythonTarball, manifest.python.sha256],
    [sqlcipherArtifact, manifest.sqlcipher.sha256],
  ]) {
    if ((await sha256(path)) !== expected) {
      throw new DeskError("NO_RUNTIME", { reason: "checksum", path });
    }
  }

  const tmp = join(root, ".tmp", randomUUID());
  await mkdir(tmp, { recursive: true });
  try {
    emit({ stage: "extract", message: "解压 Python" });
    await run("tar", ["-xzf", pythonTarball, "-C", tmp]);
    await mkdir(join(tmp, "bin"), { recursive: true });
    await copyFile(sqlcipherArtifact, join(tmp, "bin", "sqlcipher"));
    await chmod(join(tmp, "bin", "sqlcipher"), 0o755);
    await chmod(join(tmp, "python", "bin", "python3"), 0o755).catch(() => {});

    if (await exists(target)) await rm(target, { recursive: true, force: true });
    await mkdir(join(root, "runtime"), { recursive: true });
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    if (err instanceof DeskError) throw err;
    throw new DeskError("NO_RUNTIME", { reason: String(err?.message ?? err) });
  }

  await mergeState(root, { runtime: { version, readyAt: Date.now() } });
  emit({ stage: "done", message: `运行时 ${version} 就绪` });

  return {
    root,
    version,
    python: join(target, "python", "bin", "python3"),
    sqlcipher: join(target, "bin", "sqlcipher"),
  };
}
