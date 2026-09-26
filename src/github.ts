import { spawnSync } from "node:child_process";
import type { CheckState, PullRequestSnapshot } from "./decision.js";
import { which } from "./doctor.js";
import type { Comment } from "./protocol.js";

type Env = Record<string, string | undefined>;

export class GhError extends Error {}

function gh(args: readonly string[], cwd: string, env: Env): string {
  const bin = which("gh", env);
  if (bin === null) throw new GhError("gh: not found on PATH. Install GitHub CLI: https://cli.github.com");
  const result = spawnSync(bin, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    const reason = (result.stderr ?? "").trim().split("\n")[0] || `gh exited with ${result.status ?? result.signal}`;
    throw new GhError(reason);
  }
  return result.stdout;
}

function ghJson<T>(args: readonly string[], cwd: string, env: Env): T {
  const out = gh(args, cwd, env);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new GhError(`unexpected output from gh ${args.slice(0, 2).join(" ")}`);
  }
}

/** Runs `gh args` with `input` on stdin; used to post a comment without putting its text in argv. */
function ghInput(args: readonly string[], input: string, cwd: string, env: Env): string {
  const bin = which("gh", env);
  if (bin === null) throw new GhError("gh: not found on PATH. Install GitHub CLI: https://cli.github.com");
  const result = spawnSync(bin, args, { cwd, env, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    const reason = (result.stderr ?? "").trim().split("\n")[0] || `gh exited with ${result.status ?? result.signal}`;
    throw new GhError(reason);
  }
  return result.stdout;
}

/** Posts one comment on an issue; pull requests are issues too, but prefer `postPullRequestComment`. */
export function postIssueComment(number: number, body: string, cwd: string, env: Env): void {
  ghInput(["issue", "comment", String(number), "--body-file", "-"], body, cwd, env);
}

/** Posts one comment on a pull request conversation. */
export function postPullRequestComment(number: number, body: string, cwd: string, env: Env): void {
  ghInput(["pr", "comment", String(number), "--body-file", "-"], body, cwd, env);
}

/** Fetches the current body of issue `issue` in the repository `gh` resolves from `cwd`. */
export function issueBody(issue: number, cwd: string, env: Env): { body: string } | { error: string } {
  try {
    const { body } = ghJson<{ body?: unknown }>(["issue", "view", String(issue), "--json", "body"], cwd, env);
    if (typeof body === "string") return { body };
    return { error: `Could not fetch issue #${issue}: unexpected output from gh issue view. Run "gdt doctor".` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (reason.startsWith("gh: not found")) return { error: reason };
    return { error: `Could not fetch issue #${issue}: ${reason}. Check the issue number and run "gdt doctor".` };
  }
}

/** `owner/name` of the repository `gh` resolves from `cwd`. */
export function repository(cwd: string, env: Env): string {
  return ghJson<{ nameWithOwner: string }>(["repo", "view", "--json", "nameWithOwner"], cwd, env).nameWithOwner;
}

/** The login `gh` is authenticated as. */
export function viewer(cwd: string, env: Env): string {
  return ghJson<{ login: string }>(["api", "user"], cwd, env).login;
}

/** The issue body and the open pull requests that close the issue ("Closes #n"). */
export function issueSnapshot(issue: number, cwd: string, env: Env): { body: string; pullRequests: number[] } {
  const data = ghJson<{ body: string; closedByPullRequestsReferences?: { number: number }[] }>(
    ["issue", "view", String(issue), "--json", "body,closedByPullRequestsReferences"],
    cwd,
    env,
  );
  return { body: data.body, pullRequests: (data.closedByPullRequestsReferences ?? []).map((pr) => pr.number) };
}

/** All comments on an issue or pull request conversation, oldest first. */
export function comments(repo: string, number: number, cwd: string, env: Env): Comment[] {
  const pages = ghJson<{ id: number; user: { login: string } | null; created_at: string; body: string | null }[][]>(
    ["api", "--paginate", "--slurp", `repos/${repo}/issues/${number}/comments`],
    cwd,
    env,
  );
  return pages.flat().map((c) => ({ id: c.id, author: c.user?.login ?? "", created_at: c.created_at, body: c.body ?? "" }));
}

type RollupItem =
  | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null }
  | { __typename: "StatusContext"; context: string; state: string };

/** Maps GitHub check runs and commit statuses to success, pending or failure; anything unexpected fails. */
export function checkStates(rollup: readonly RollupItem[]): Record<string, CheckState> {
  const states: Record<string, CheckState> = {};
  for (const item of rollup) {
    if (item.__typename === "CheckRun") {
      states[item.name] = item.status !== "COMPLETED" ? "pending" : item.conclusion === "SUCCESS" ? "success" : "failure";
    } else {
      states[item.context] = item.state === "SUCCESS" ? "success" : item.state === "PENDING" || item.state === "EXPECTED" ? "pending" : "failure";
    }
  }
  return states;
}

export function pullRequest(number: number, cwd: string, env: Env): PullRequestSnapshot {
  const data = ghJson<{ number: number; headRefOid: string; mergeable: string; statusCheckRollup: RollupItem[] | null }>(
    ["pr", "view", String(number), "--json", "number,headRefOid,mergeable,statusCheckRollup"],
    cwd,
    env,
  );
  const mergeable = data.mergeable === "MERGEABLE" ? "mergeable" : data.mergeable === "CONFLICTING" ? "conflicting" : "unknown";
  return { number: data.number, head: data.headRefOid, mergeable, checks: checkStates(data.statusCheckRollup ?? []) };
}
