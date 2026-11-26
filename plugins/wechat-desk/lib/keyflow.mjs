import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const KEYHOOK = fileURLToPath(new URL("../tools/keyhook.py", import.meta.url));

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Detached on purpose: the QR wait spans agent turns, so the daemon must
// outlive whichever turn started it.
export async function startKeyhook(opts) {
  const root = opts.root;
  const lockPath = join(root, "keyhook.lock");

  const existing = await readFile(lockPath, "utf8").catch(() => null);
  const existingPid = existing ? Number(existing.trim()) : NaN;
  if (Number.isInteger(existingPid) && existingPid > 0 && alive(existingPid)) {
    return { pid: existingPid, reused: true };
  }
  if (existing) await rm(lockPath, { force: true });

  const args = [
    KEYHOOK,
    "--app", opts.appBin,
    "--hook", opts.hookPath,
    "--root", root,
    "--timeout", String(opts.timeoutSec ?? 300),
  ];
  if (opts.dryRun) args.push("--dry-run");

  const child = spawn(opts.python ?? "python3", args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  await writeFile(lockPath, String(child.pid), { mode: 0o600 });
  return { pid: child.pid, reused: false };
}

export async function waitForKey(opts) {
  const root = opts.root;
  const pollMs = opts.pollMs ?? 300;
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
  const statePath = join(root, "keyhook.json");

  for (;;) {
    const state = await readJson(statePath);
    if (state?.phase === "captured") {
      const key = await readFile(join(root, "key.txt"), "utf8").catch(() => "");
      if (/^[0-9a-f]{64}$/.test(key.trim())) return { ok: true };
      return { ok: false, code: "KEY_INVALID" };
    }
    if (state?.phase === "failed") {
      return { ok: false, code: state.code ?? "KEY_INVALID" };
    }
    if (Date.now() >= deadline) return { ok: false, code: "TIMEOUT" };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function keyStatus(root) {
  const state = await readJson(join(root, "keyhook.json"));
  const key = await readFile(join(root, "key.txt"), "utf8").catch(() => null);
  return {
    phase: state?.phase ?? "idle",
    code: state?.code ?? null,
    pid: state?.pid ?? null,
    hasKey: Boolean(key && /^[0-9a-f]{64}$/.test(key.trim())),
  };
}
