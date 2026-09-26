import { spawnSync } from "node:child_process";
import { which } from "./doctor.js";

type Env = Record<string, string | undefined>;

/** Fetches the current body of issue `issue` in the repository `gh` resolves from `cwd`. */
export function issueBody(issue: number, cwd: string, env: Env): { body: string } | { error: string } {
  const gh = which("gh", env);
  if (gh === null) return { error: "gh: not found on PATH. Install GitHub CLI: https://cli.github.com" };
  const result = spawnSync(gh, ["issue", "view", String(issue), "--json", "body"], { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    const reason = (result.stderr ?? "").trim().split("\n")[0] || `gh exited with ${result.status ?? result.signal}`;
    return { error: `Could not fetch issue #${issue}: ${reason}. Check the issue number and run "gdt doctor".` };
  }
  try {
    const { body } = JSON.parse(result.stdout) as { body?: unknown };
    if (typeof body === "string") return { body };
  } catch {
    // Reported below.
  }
  return { error: `Could not fetch issue #${issue}: unexpected output from gh issue view. Run "gdt doctor".` };
}
