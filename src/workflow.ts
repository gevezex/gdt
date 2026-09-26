import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { relative } from "node:path";
import { headless } from "./backends/headless.js";
import { loadConfig, ROLES } from "./config.js";
import { validateContract } from "./contract.js";
import { findRepository } from "./doctor.js";
import { issueBody, repository } from "./github.js";
import { loadLocale } from "./locale.js";
import { alive, lockHolder, paths, readState, type State, writeState } from "./state.js";
import { cliPath } from "./supervisor.js";

type Env = Record<string, string | undefined>;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr });

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function changedFiles(root: string, env: Env): string[] {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, env, encoding: "utf8" });
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3));
}

function newState(issue: number, repo: string): State {
  return {
    version: 1,
    issue,
    workflow_id: randomBytes(3).toString("hex"),
    status: "starting",
    reason: "",
    role: null,
    round: null,
    exit_code: null,
    repository: repo,
    pr_number: null,
    head: null,
    head_transition_at: null,
    contract: null,
    dispatched: [],
    inflight: null,
    notified_status: null,
    pids: { supervisor: null, workers: {} },
    updated_at: "",
  };
}

/** `gdt start <n>`: preflight, then starts a detached supervisor and returns. */
export function start(issue: number, cwd: string, env: Env): CommandResult {
  const root = findRepository(cwd);
  if (root === null) return fail(`${cwd} is not inside a Git repository. Run gdt from a checkout of the target repository.\n`);
  const { report } = loadConfig(root, env);
  if (!report.valid) return fail('.gdt/config.toml is invalid. Run "gdt doctor" for details.\n');
  if (report.workflow.terminal !== "headless") {
    return fail(`workflow.terminal = "${report.workflow.terminal}" is not available yet. Set workflow.terminal = "headless".\n`);
  }

  const p = paths(root, issue, env);
  const holder = lockHolder(p);
  if (holder !== null) return fail(`Supervisor for #${issue} is already running (pid ${holder})\n`);

  const existing = readState(p);
  if (existing === null || existing.dispatched.length === 0) {
    const changed = changedFiles(root, env);
    if (changed.length > 0) return fail(`Working tree not clean: ${changed.join(", ")}. Commit or stash before starting.\n`);
  }

  const fetched = issueBody(issue, root, env);
  if ("error" in fetched) return fail(`${fetched.error}\n`);
  let locale;
  try {
    locale = loadLocale(report.language);
  } catch (err) {
    return fail(`${err instanceof Error ? err.message : String(err)}\n`);
  }
  const contract = validateContract(fetched.body, locale, { maxAcceptanceCriteria: report.contract.max_acceptance_criteria });
  if (!contract.valid) {
    const lines = contract.errors.map((error) => `  - ${error}`).join("\n");
    return fail(`Issue #${issue}: contract invalid (${contract.errors.length} error(s))\n${lines}\nFix the issue body, then run "gdt start ${issue}" again.\n`);
  }

  let state: State;
  try {
    state = existing ?? newState(issue, repository(root, env));
  } catch (err) {
    return fail(`Could not read the repository with gh: ${err instanceof Error ? err.message : String(err)}. Run "gdt doctor".\n`);
  }
  Object.assign(state, { status: "starting", reason: existing === null ? "" : "resuming", pids: { supervisor: null, workers: {} } });
  writeState(p, state);

  const backend = headless(p.logs, root, env);
  backend.ensureWorkspace();
  const pid = backend.spawnPane("supervisor", [process.execPath, cliPath(), "_supervise", String(issue)]);
  const running = () => lockHolder(p) === pid && readState(p)?.pids.supervisor === pid;
  for (let waited = 0; waited < 4000 && !running() && alive(pid); waited += 50) sleepSync(50);
  const logs = relative(root, p.logs) || p.logs;
  if (!running()) return fail(`Supervisor for #${issue} exited during startup; see ${logs}/supervisor.log\n`);
  return ok(`Supervisor started for #${issue}; logs: ${logs}\nworkflow ${state.workflow_id}. Next: gdt status ${issue}\n`);
}

/** `gdt stop <n>`: stops the supervisor, workers and running agents; `gdt start` resumes. */
export function stop(issue: number, cwd: string, env: Env): CommandResult {
  const root = findRepository(cwd) ?? cwd;
  const p = paths(root, issue, env);
  const before = readState(p);
  if (before === null) return fail(`No workflow for #${issue}. Next: gdt start ${issue}\n`);

  const backend = headless(p.logs, root, env);
  const pids = [lockHolder(p), before.pids.supervisor, ...ROLES.map((role) => before.pids.workers[role])];
  for (const pid of new Set(pids)) if (pid !== null && pid !== undefined && alive(pid)) backend.close(pid);
  rmSync(p.lock, { force: true });

  // Re-read: the supervisor may have written state until it was stopped.
  const state = readState(p) ?? before;
  Object.assign(state, { status: "stopped", reason: "", pids: { supervisor: null, workers: {} } });
  writeState(p, state);
  return ok(`Stopped #${issue}. Next: gdt start ${issue}\n`);
}

function blockedHint(issue: number, reason: string): string {
  if (reason.startsWith("round budget exhausted")) return `gdt allow-round ${issue}`;
  if (reason.includes("without a visible handoff") || reason.includes("already ran")) return `gdt retry ${issue}`;
  if (reason.includes("without a Changelog update")) return `add a Changelog entry to issue #${issue}, or revert the body change`;
  return "resolve the cause; the supervisor checks again on every poll";
}

/** The one-line status and the next step. */
export function describe(state: State, supervisorAlive: boolean): { line: string; next: string } {
  const n = state.issue;
  const active = !["stopped", "failed"].includes(state.status);
  if (active && !supervisorAlive) return { line: `supervisor not running (last status: ${state.status})`, next: `gdt start ${n}` };
  const withReason = state.reason === "" ? state.status : `${state.status}: ${state.reason}`;
  switch (state.status) {
    case "failed":
      return { line: state.reason, next: `gdt retry ${n}` };
    case "stopped":
      return { line: "stopped", next: `gdt start ${n}` };
    case "running":
      return { line: `running: ${state.role ?? "?"} turn, round ${state.round ?? 0}`, next: "wait" };
    case "blocked":
      return { line: withReason, next: blockedHint(n, state.reason) };
    case "awaiting_human":
      return { line: withReason, next: `gdt answer ${n} <question-id> "<answer>"` };
    case "ready_to_merge":
      return { line: withReason, next: `review and merge pull request #${state.pr_number ?? "?"}` };
    default:
      return { line: withReason, next: "wait" };
  }
}

/** `gdt status <n>`. */
export function status(issue: number, cwd: string, env: Env, json: boolean): CommandResult {
  const root = findRepository(cwd) ?? cwd;
  const p = paths(root, issue, env);
  const state = readState(p);
  if (state === null) {
    return json
      ? { code: 1, stdout: `${JSON.stringify({ issue, status: null, next_step: `gdt start ${issue}` }, null, 2)}\n`, stderr: "" }
      : fail(`No workflow for #${issue}. Next: gdt start ${issue}\n`);
  }
  const { line, next } = describe(state, lockHolder(p) !== null);
  if (!json) return ok(`${line}. Next: ${next}\n`);
  const out = {
    issue,
    workflow_id: state.workflow_id,
    status: state.status,
    reason: state.reason,
    role: state.role,
    round: state.round,
    exit_code: state.exit_code,
    pr_number: state.pr_number,
    next_step: next,
  };
  return ok(`${JSON.stringify(out, null, 2)}\n`);
}
