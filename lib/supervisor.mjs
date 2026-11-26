import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// KeepAlive + RunAtLoad is what makes "enabled" mean "receiving": the agent is
// restarted if it dies and started at login.
export function launchAgentPlist({ label, program, args, root }) {
  const all = [program, ...args].map((a) => `    <string>${esc(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${all}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${esc(join(root, "logs", "agent.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(join(root, "logs", "agent.log"))}</string>
</dict>
</plist>
`;
}

export async function installAgent(opts) {
  const agentsDir = opts.agentsDir ?? join(homedir(), "Library/LaunchAgents");
  await mkdir(agentsDir, { recursive: true });
  await mkdir(join(opts.root, "logs"), { recursive: true, mode: 0o700 });
  const path = join(agentsDir, `${opts.label}.plist`);
  await writeFile(path, launchAgentPlist(opts), { mode: 0o644 });

  if (opts.load !== false) {
    await run("launchctl", ["unload", path]).catch(() => {});
    await run("launchctl", ["load", path]).catch(() => {});
  }
  return { path };
}

export async function uninstallAgent(opts) {
  const agentsDir = opts.agentsDir ?? join(homedir(), "Library/LaunchAgents");
  const path = join(agentsDir, `${opts.label}.plist`);
  if (opts.load !== false) await run("launchctl", ["unload", path]).catch(() => {});
  await rm(path, { force: true });
  return { path };
}
