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

/**
 * The distinct names of the check runs and commit statuses on the latest commit of the repository's
 * default branch, sorted alphabetically. Returns `[]` when `gh` cannot read them (no remote, no
 * authentication, no GitHub): `gdt init` then treats the repository as having no detected checks.
 */
export function detectedChecks(cwd: string, env: Env): string[] {
  try {
    const repo = ghJson<{ nameWithOwner?: unknown; defaultBranchRef?: { name?: unknown } }>(
      ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
      cwd,
      env,
    );
    const name = typeof repo.nameWithOwner === "string" ? repo.nameWithOwner : null;
    const branch = typeof repo.defaultBranchRef?.name === "string" ? repo.defaultBranchRef.name : null;
    if (name === null || branch === null) return [];
    const runs = ghJson<{ check_runs?: { name?: unknown }[] }>(
      ["api", `repos/${name}/commits/${branch}/check-runs`],
      cwd,
      env,
    );
    const statuses = ghJson<{ statuses?: { context?: unknown }[] }>(
      ["api", `repos/${name}/commits/${branch}/status`],
      cwd,
      env,
    );
    const names = [
      ...(runs.check_runs ?? []).map((run) => run.name),
      ...(statuses.statuses ?? []).map((status) => status.context),
    ].filter((value): value is string => typeof value === "string" && value !== "");
    return [...new Set(names)].sort();
  } catch {
    return [];
  }
}

/** True when `body` contains a closing keyword ("Closes #n", "fixes #n", ...) for exactly issue `issue`. */
export function closesIssue(body: string, issue: number): boolean {
  return new RegExp(`(?<![\\w])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issue}(?!\\d)`, "i").test(body);
}

/**
 * The issue body and the workflow's pull requests: the open pull requests GitHub links as closing the
 * issue, or, when there are none, the open pull requests whose body closes the issue without GitHub
 * having linked them (`unlinked` is then true). The fallback costs one `gh api --paginate` call that
 * reads every open pull request, so an older pull request is never cut off by a list limit.
 */
export function issueSnapshot(issue: number, cwd: string, env: Env): { body: string; pullRequests: number[]; unlinked: boolean } {
  const data = ghJson<{ body: string; closedByPullRequestsReferences?: { number: number }[] }>(
    ["issue", "view", String(issue), "--json", "body,closedByPullRequestsReferences"],
    cwd,
    env,
  );
  const linked = (data.closedByPullRequestsReferences ?? []).map((pr) => pr.number);
  if (linked.length > 0) return { body: data.body, pullRequests: linked, unlinked: false };
  const pages = ghJson<{ number: number; body: string | null }[][]>(
    ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/pulls?state=open&per_page=100"],
    cwd,
    env,
  );
  const unlinked = pages
    .flat()
    .filter((pr) => closesIssue(pr.body ?? "", issue))
    .map((pr) => pr.number)
    .sort((x, y) => x - y);
  return { body: data.body, pullRequests: unlinked, unlinked: unlinked.length > 0 };
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
