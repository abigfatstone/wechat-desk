#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODES, DeskError } from "../lib/errors.mjs";
import { probe } from "../lib/probe.mjs";
import { prepareRuntime } from "../lib/runtime.mjs";
import { prepareQuery } from "../lib/query-layer.mjs";
import { verifyKey } from "../lib/verify-key.mjs";
import { queryOnce } from "../lib/query.mjs";
import { prepareCopy } from "../lib/bundle.mjs";
import { signCopy } from "../lib/sign.mjs";
import { keyStatus, startKeyhook, waitForKey } from "../lib/keyflow.mjs";
import { ilink } from "../lib/ilink.mjs";
import { loadBinding, publicBinding, saveBinding } from "../lib/binding.mjs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";

const DEFAULT_ROOT = join(process.env.HOME ?? ".", "Library/Application Support/WeChatDesk");

// Flags carry values except the few that are switches. An unknown flag is an
// error, not something to ignore: `--key <raw>` typed at a shell must never be
// swallowed and left in the process list.
const SWITCHES = new Set(["json"]);
const ALLOWED = {
  probe: ["app-path", "data-root", "root", "json"],
  "prepare-runtime": ["root", "offline", "json"],
  "prepare-query": ["root", "source", "json"],
  "verify-key": ["root", "db", "key-file", "json"],
  key: ["root", "app-path", "hook", "timeout", "timeout-ms", "free-bytes", "json"],
  bind: ["root", "json"],
  query: ["root", "value", "days", "limit", "offset", "json"],
};

function parse(cmd, argv) {
  const allowed = new Set(ALLOWED[cmd] ?? []);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new DeskError("BAD_ARGS", { arg: token });
    const name = token.slice(2);
    if (!allowed.has(name)) throw new DeskError("BAD_ARGS", { arg: token });
    if (SWITCHES.has(name)) {
      out[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new DeskError("BAD_ARGS", { arg: token });
    out[name] = value;
    i++;
  }
  return out;
}

const num = (v) => (v === undefined ? undefined : Number(v));

async function run(cmd, f, action) {
  const root = f.root ?? DEFAULT_ROOT;

  if (cmd === "probe") {
    const result = await probe({ appPath: f["app-path"], dataRoot: f["data-root"], root });
    return { ok: true, ...result };
  }

  if (cmd === "prepare-runtime") {
    const result = await prepareRuntime({
      root,
      offlineDir: f.offline,
      onEvent: (e) => process.stderr.write(JSON.stringify(e) + "\n"),
    });
    return { ok: true, ...result };
  }

  if (cmd === "prepare-query") {
    const source = f.source ?? fileURLToPath(new URL("../vendor/wechat-decrypt", import.meta.url));
    return { ok: true, ...(await prepareQuery({ sourceDir: source, root })) };
  }

  if (cmd === "verify-key") {
    if (!f.db) throw new DeskError("BAD_ARGS", { arg: "--db" });
    // The key is only ever read from a file: never argv, never printed.
    const key = (await readFile(f["key-file"] ?? join(root, "key.txt"), "utf8")).trim();
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new DeskError("BAD_ARGS", { arg: "--key-file" });
    const result = await verifyKey({ root, key: key.toLowerCase(), dbPath: f.db });
    return { ...result, _code: result.ok ? 0 : 3 };
  }

  if (cmd === "bind") {
    const existing = await loadBinding(root);
    const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : null;
    const qr = createRequire(import.meta.url)("../plugins/wechat-desk/vendor/qr.cjs");
    try {
      const binding = await ilink().bind({
        previous: existing,
        show: async (url) => {
          process.stderr.write(url + "\n");
          qr.generate(url, { small: true });
        },
        pin: async () => (rl ? (await rl.question("输入微信显示的数字：")).trim() : ""),
      });
      await saveBinding(root, binding);
      return { ok: true, ...publicBinding(binding) };
    } finally {
      rl?.close();
    }
  }

  if (cmd === "key") {
    const root = f.root ?? DEFAULT_ROOT;

    if (action === "prepare") {
      const copy = await prepareCopy({ root, appPath: f["app-path"], freeBytes: num(f["free-bytes"]) });
      const signed = await signCopy(copy.copyPath);
      return { ok: true, ...copy, ...signed };
    }
    if (action === "start") {
      const appBin = join(root, "wechat-copy", "WeChat.app", "Contents", "MacOS", "WeChat");
      const hook = f.hook ?? fileURLToPath(new URL("../vendor/wechat-decrypt/scripts/macos/hook_pbkdf.js", import.meta.url));
      return { ok: true, ...(await startKeyhook({ root, appBin, hookPath: hook, timeoutSec: num(f.timeout) })) };
    }
    if (action === "wait") {
      return { ...(await waitForKey({ root, timeoutMs: num(f["timeout-ms"]) })) };
    }
    if (action === "status") {
      return { ok: true, ...(await keyStatus(root)) };
    }
    throw new DeskError("BAD_ARGS", { arg: action });
  }

  throw new DeskError("BAD_ARGS", { cmd });
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!ALLOWED[cmd]) throw new DeskError("BAD_ARGS", { cmd });

  if (cmd === "key") {
    const [action, ...tail] = rest;
    const result = await run("key", parse("key", tail), action);
    return { ...result, _code: result.ok === false ? 3 : 0 };
  }

  if (cmd === "query") {
    const [op, ...tail] = rest;
    const f = parse(cmd, tail);
    const result = await queryOnce({
      root: f.root ?? DEFAULT_ROOT,
      op,
      value: f.value,
      days: num(f.days),
      limit: num(f.limit),
      offset: num(f.offset),
    });
    return { ...result, _code: result.ok ? 0 : 3 };
  }

  const { _code, ...result } = await run(cmd, parse(cmd, rest), rest[0]);
  return { ...result, _code: _code ?? 0 };
}

main()
  .then(({ _code, ...result }) => {
    // Every outcome is JSON on stdout, so a caller can parse it unconditionally.
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(_code ?? 0);
  })
  .catch((err) => {
    const code = err instanceof DeskError ? err.code : "IO_ERROR";
    const message = err instanceof DeskError ? CODES[code] : String(err?.message ?? err);
    process.stdout.write(JSON.stringify({ ok: false, code, message }) + "\n");
    process.stderr.write(message + "\n");
    process.exit(code === "BAD_ARGS" ? 2 : 3);
  });
