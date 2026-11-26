#!/usr/bin/env node
import { CODES, DeskError } from "../lib/errors.mjs";
import { probe } from "../lib/probe.mjs";
import { prepareRuntime } from "../lib/runtime.mjs";
import { prepareQuery } from "../lib/query-layer.mjs";
import { verifyKey } from "../lib/verify-key.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const [, , cmd, ...rest] = process.argv;

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new DeskError("BAD_ARGS", { arg: key });
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new DeskError("BAD_ARGS", { arg: key });
    out[key.slice(2)] = value;
    i++;
  }
  return out;
}

async function main() {
  if (cmd === "probe") {
    const f = flags(rest);
    const result = await probe({
      appPath: f["app-path"],
      dataRoot: f["data-root"],
    });
    process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + "\n");
    return 0;
  }
  if (cmd === "prepare-runtime") {
    const f = flags(rest);
    const result = await prepareRuntime({
      root: f.root,
      offlineDir: f.offline,
      onEvent: (e) => process.stderr.write(JSON.stringify(e) + "\n"),
    });
    process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + "\n");
    return 0;
  }
  if (cmd === "prepare-query") {
    const f = flags(rest);
    const result = await prepareQuery({
      sourceDir: f.source ?? new URL("../vendor/wechat-decrypt", import.meta.url).pathname,
      root: f.root,
    });
    process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + "\n");
    return 0;
  }
  if (cmd === "verify-key") {
    const f = flags(rest);
    if (!f.db) throw new DeskError("BAD_ARGS", { arg: "--db" });
    const root = f.root ?? join(process.env.HOME ?? ".", "Library/Application Support/WeChatDesk");
    // The key is only ever read from a file: never from argv, never printed.
    const keyFile = f["key-file"] ?? join(root, "query", "key.txt");
    const key = (await readFile(keyFile, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(key)) throw new DeskError("BAD_ARGS", { arg: "--key-file" });
    const result = await verifyKey({ root, key, dbPath: f.db });
    process.stdout.write(JSON.stringify(result) + "\n");
    return result.ok ? 0 : 3;
  }
  throw new DeskError("BAD_ARGS", { cmd });
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const code = err instanceof DeskError ? err.code : "IO_ERROR";
    process.stderr.write(
      JSON.stringify({ ok: false, code, message: CODES[code] ?? String(err.message) }) + "\n",
    );
    process.exit(code === "BAD_ARGS" ? 2 : 3);
  });
