import { spawnSync } from "node:child_process";
import { which } from "./doctor.js";

type Env = Record<string, string | undefined>;

function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const NOTIFIERS: { name: string; args: (title: string, message: string) => string[] }[] = [
  { name: "terminal-notifier", args: (title, message) => ["-title", title, "-message", message] },
  {
    name: "osascript",
    args: (title, message) => ["-e", `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`],
  },
  { name: "notify-send", args: (title, message) => [title, message] },
];

/**
 * Sends one notification through the first notifier that is on PATH and succeeds; otherwise writes one
 * line with `log`. Returns the notifier used, or "log".
 */
export function notify(title: string, message: string, env: Env, log: (line: string) => void): string {
  for (const notifier of NOTIFIERS) {
    const bin = which(notifier.name, env);
    if (bin === null) continue;
    const result = spawnSync(bin, notifier.args(title, message), { env, stdio: "ignore", timeout: 10_000 });
    if (result.status === 0) return notifier.name;
  }
  log(`notification: ${title}: ${message}`);
  return "log";
}
