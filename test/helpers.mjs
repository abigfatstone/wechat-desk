import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeApp(version) {
  const dir = await mkdtemp(join(tmpdir(), "desk-app-"));
  const app = join(dir, "WeChat.app");
  await mkdir(join(app, "Contents"), { recursive: true });
  await writeFile(
    join(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>
`,
  );
  return app;
}

export async function makeData({ shards = 1, account = "acct" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "desk-data-"));
  const dir = join(root, "xwechat_files", account, "db_storage", "message");
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < shards; i++) {
    await writeFile(join(dir, `message_${i}.db`), Buffer.alloc(16, i));
  }
  return root;
}

export async function makeTemp(prefix = "desk-") {
  return mkdtemp(join(tmpdir(), prefix));
}
