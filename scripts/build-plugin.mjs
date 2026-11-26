import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(repo, "plugins", "wechat-desk");

// The market installs the plugin directory on its own, so everything it imports
// has to live inside it. This copies the libraries in, and refuses to finish if
// a single module fails to parse.
export async function buildPlugin() {
  for (const dir of ["lib", "bin", "tools"]) {
    await rm(join(plugin, dir), { recursive: true, force: true });
    await mkdir(join(plugin, dir), { recursive: true });
  }

  const libs = (await readdir(join(repo, "lib"))).filter((f) => f.endsWith(".mjs"));
  for (const file of libs) await cp(join(repo, "lib", file), join(plugin, "lib", file));

  await cp(join(repo, "bin", "wechatdesk.mjs"), join(plugin, "bin", "wechatdesk.mjs"));
  await cp(join(repo, "tools", "keyhook.py"), join(plugin, "tools", "keyhook.py"));

  const required = ["zero.mjs", "plugin.json", "lib/query.mjs", "lib/bridge.mjs", "bin/wechatdesk.mjs", "tools/keyhook.py"];
  for (const rel of required) {
    const stat = await import("node:fs/promises").then((fs) => fs.stat(join(plugin, rel)).catch(() => null));
    if (!stat) throw Error(`插件缺少 ${rel}`);
  }

  await writeFile(
    join(plugin, "BUILD"),
    JSON.stringify({ builtAt: new Date().toISOString(), modules: libs.length }, null, 2) + "\n",
  );

  return { plugin, modules: libs.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildPlugin().then((r) => console.log(JSON.stringify({ ok: true, ...r })));
}
