import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

export const hash = (s) => createHash("sha256").update(s).digest("hex");
export async function scope(
  directory,
  home = join(homedir(), ".zero-wechat-desk"),
) {
  const root = await realpath(directory);
  const dir = join(
    home,
    hash(process.platform === "win32" ? root.toLowerCase() : root),
  );
  const load = async (name) => {
    try {
      return JSON.parse(await readFile(join(dir, name + ".json"), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  };
  const save = async (name, data) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, randomUUID() + ".tmp");
    try {
      await writeFile(temp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
      await rename(temp, join(dir, name + ".json"));
    } finally {
      await rm(temp, { force: true });
    }
  };
  const grant = async (host) => {
    const g = await load("grant");
    if (!g || g.root !== root || g.host !== host)
      throw Error("此 workspace 未授权给当前宿主");
    if (g.catalog) {
      const catalog = JSON.parse(await readFile(g.catalog, "utf8"));
      if (
        !catalog.bundles?.some(
          (b) => b.id === "wechat-desk" && b.enabled === true,
        )
      )
        throw Error("微信工作台已停用");
    }
    return g;
  };
  return {
    root,
    dir,
    load,
    save,
    grant,
    drop: (name) => rm(join(dir, name + ".json"), { force: true }),
  };
}
