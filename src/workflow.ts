import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { headless } from "./backends/headless.js";
import { type Backend, backendFor } from "./backends/index.js";
import { DEFAULT_TURN_TIMEOUT_MINUTES, loadConfig, ROLES, userConfigPath } from "./config.js";
import { validateContract } from "./contract.js";
import { findRepository, herdrPreflight, unsupportedAgentFindings } from "./doctor.js";
import { changedFiles } from "./git.js";
import { issueBody, repository } from "./github.js";
import { loadLocale } from "./locale.js";
import { isInvalidRecordReason } from "./protocol.js";
import { alive, lockHolder, type Paths, paths, readOverrides, readState, type State, type Status, writeState } from "./state.js";
import { cliPath, isTimeoutReason, turnDeadline } from "./supervisor.js";

type Env = Record<string, string | undefined>;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });
export const fail = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr });

/** Statuses that need a person or end the workflow: `gdt wait` returns when it reaches one. */
const ACTION_STATUSES: readonly Status[] = [
  "awaiting_human",
  "blocked",
  "failed",
  "ready_to_merge",
  "contract_changed",
  "stopped",
];

/** How often `gdt wait` re-reads the local state; well under the 2 seconds the contract allows. */
const WAIT_POLL_MS = 200;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
    open_findings: [],
    pids: { supervisor: null, workers: {} },
    updated_at: "",
  };
}

/** `gdt start <n>`: preflight, then starts a detached supervisor and returns. */
export function start(issue: number, cwd: string, env: Env): CommandResult {
  const root = findRepository(cwd);
  if (root === null) return fail(`${cwd} is not inside a Git repository. Run gdt from a checkout of the target repository.\n`);
  const { report, findings } = loadConfig(root, env);
  if (!report.valid) {
    // AC-2: `gdt start` refuses with the same config errors as `gdt doctor`.
    const errors = findings.filter((finding) => finding.level === "error").map((finding) => finding.message);
    return fail(`${errors.join("\n")}\nRun "gdt doctor" for details.\n`);
  }
  const unsupported = unsupportedAgentFindings(report.roles, userConfigPath(env));
  if (unsupported.length > 0) return fail(`${unsupported.map((f) => f.message).join("\n")}\n`);
  if (report.workflow.terminal === "herdr") {
    const problem = herdrPreflight(env);
    if (problem !== null) return fail(`${problem}\n`);
  }

  const p = paths(root, issue, env);
  const holder = lockHolder(p);
  if (holder !== null) return fail(`Supervisor for #${issue} is already running (pid ${holder})\n`);

  const existing = readState(p);
  if (existing?.status === "failed") return fail(`Workflow for #${issue} failed: ${existing.reason}. Next: gdt retry ${issue}\n`);
  if (existing === null || existing.dispatched.length === 0) {
    const changed = changedFiles(root, env, true);
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

  let backend: Backend;
  let pid: number;
  try {
    backend = backendFor(report, root, issue, env, p);
    backend.ensureWorkspace();
    pid = backend.spawnPane("supervisor", [process.execPath, cliPath(), "_supervise", String(issue)]);
  } catch (err) {
    return fail(`Could not start the supervisor for #${issue}: ${err instanceof Error ? err.message : String(err)}. Run "gdt doctor".\n`);
  }
  const running = () => lockHolder(p) === pid && readState(p)?.pids.supervisor === pid;
  for (let waited = 0; waited < 4000 && !running() && alive(pid); waited += 50) sleepSync(50);
  const logs = relative(root, p.logs) || p.logs;
  if (!running()) return fail(`Supervisor for #${issue} exited during startup; see ${logs}/supervisor.log\n`);
  const attach = backend.attach();
  const attachLine = attach === null ? "" : `Attach: ${attach}\n`;
  return ok(`Supervisor started for #${issue}; logs: ${logs}\n${attachLine}workflow ${state.workflow_id}. Next: gdt status ${issue}\n`);
}

/** The workflow's terminal backend; falls back to the headless one when the config is unreadable. */
function loadBackend(p: Paths, issue: number, env: Env): Backend {
  const { report } = loadConfig(p.root, env);
  return report.valid ? backendFor(report, p.root, issue, env, p) : headless(p.logs, p.root, env);
}

/**
 * Stops the supervisor, its workers and any running agent. It does not release the lock: the caller
 * releases it after writing the final state, so `gdt wait` never sees the lock vanish while the state
 * is still a waiting status (AC-4 would otherwise fire for a deliberate stop).
 */
export function stopProcesses(p: Paths, state: State, env: Env): void {
  // The stop window starts here; `gdt wait` keeps waiting while this process lives (see stopInProgress).
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.stopping, `${process.pid}\n`);
  const backend = loadBackend(p, state.issue, env);
  const pids = [lockHolder(p), state.pids.supervisor, ...ROLES.map((role) => state.pids.workers[role])];
  for (const pid of new Set(pids)) if (pid !== null && pid !== undefined && alive(pid)) backend.close(pid);
}

/** Ends the stop window: releases the lock after the final state is written, then the stop marker. */
function releaseAfterStop(p: Paths): void {
  rmSync(p.lock, { force: true });
  rmSync(p.stopping, { force: true });
}

/** True while a live `gdt stop` or `gdt retry` is between ending the supervisor and writing the final state. */
function stopInProgress(p: Paths): boolean {
  if (!existsSync(p.stopping)) return false;
  const pid = Number(readFileSync(p.stopping, "utf8").trim());
  return Number.isInteger(pid) && alive(pid);
}

/** AC-6: after stopping, every herdr pane shows STOPPED; the gdt processes printed the last line. */
function markStopped(p: Paths, issue: number, env: Env): void {
  const { report } = loadConfig(p.root, env);
  if (!report.valid || report.workflow.terminal !== "herdr") return;
  try {
    const backend = backendFor(report, p.root, issue, env, p);
    backend.setTitle("supervisor", "supervisor · stopped");
    for (const role of ROLES) backend.setTitle(role, `${role} · ${report.roles[role].agent} · STOPPED`);
    // AC-5: `stopped` reports `idle` for the supervisor pane.
    backend.reportState("supervisor", "idle");
  } catch {
    // The processes are already stopped; a missing herdr must not fail `gdt stop`.
  }
}

/** `gdt stop <n>`: stops the supervisor, workers and running agents; `gdt start` resumes. */
export function stop(issue: number, cwd: string, env: Env): CommandResult {
  const root = findRepository(cwd) ?? cwd;
  const p = paths(root, issue, env);
  const before = readState(p);
  if (before === null) return fail(`No workflow for #${issue}. Next: gdt start ${issue}\n`);

  stopProcesses(p, before, env);

  // Re-read: the supervisor may have written state until it was stopped.
  const state = readState(p) ?? before;
  // A failed turn keeps its status and reason; only the recovery step (gdt retry) clears it.
  if (state.status === "failed") Object.assign(state, { pids: { supervisor: null, workers: {} } });
  else Object.assign(state, { status: "stopped", reason: "", pids: { supervisor: null, workers: {} } });
  writeState(p, state);
  // Release the lock only now: `gdt wait` must return on the final status, never on the vanished lock.
  releaseAfterStop(p);
  markStopped(p, issue, env);
  // The printed next step is exactly what `gdt status` reports after this command.
  return ok(`Stopped #${issue}. Next: ${describe(state, false).next}\n`);
}

/** States from which `gdt retry` may clear the interrupted turn: a failed turn, or a blocked one that never produced a usable record. */
function retryable(state: State): boolean {
  if (state.status === "failed") return true;
  return (
    state.status === "blocked" &&
    (state.reason.includes("without a visible handoff") ||
      state.reason.includes("already ran") ||
      isTimeoutReason(state.reason) ||
      isInvalidRecordReason(state.reason))
  );
}

/** `gdt retry <n>`: stops the workflow and clears the interrupted turn so `gdt start` runs it again. */
export function retry(issue: number, cwd: string, env: Env): CommandResult {
  const root = findRepository(cwd) ?? cwd;
  const p = paths(root, issue, env);
  const state = readState(p);
  if (state === null) return fail(`No workflow for #${issue}. Next: gdt start ${issue}\n`);
  if (!retryable(state)) {
    return fail(`Workflow for #${issue} is not in a retryable state (status ${state.status}). Next: ${describe(state, lockHolder(p) !== null).next}\n`);
  }

  stopProcesses(p, state, env);
  const key = state.inflight?.key ?? state.blocked_key ?? undefined;
  if (key !== undefined) {
    rmSync(p.started(key), { force: true });
    rmSync(p.result(key), { force: true });
    state.dispatched = state.dispatched.filter((known) => known !== key);
  }
  Object.assign(state, {
    status: "stopped",
    reason: "",
    exit_code: null,
    inflight: null,
    blocked_key: null,
    pids: { supervisor: null, workers: {} },
  });
  writeState(p, state);
  // Release the lock only now: `gdt wait` must return on the final status, never on the vanished lock.
  releaseAfterStop(p);
  return ok(`Retry prepared for #${issue}. Next: ${describe(state, false).next}\n`);
}

function blockedHint(issue: number, reason: string): string {
  if (reason.startsWith("round budget exhausted")) return `gdt allow-round ${issue}`;
  if (
    reason.includes("without a visible handoff") ||
    reason.includes("already ran") ||
    isTimeoutReason(reason) ||
    isInvalidRecordReason(reason)
  ) {
    return `gdt retry ${issue}`;
  }
  if (reason.includes("without a Changelog update")) return `add a Changelog entry to issue #${issue}, or revert the body change`;
  return "resolve the cause; the supervisor checks again on every poll";
}

/** The one-line status and the next step. */
export function describe(state: State, supervisorAlive: boolean): { line: string; next: string } {
  const n = state.issue;
  if (state.status === "paused") return { line: "paused", next: `gdt resume ${n}` };
  // In herdr mode the supervisor exits after `ready_to_merge`; merging needs no live supervisor.
  const active = !["stopped", "failed", "ready_to_merge"].includes(state.status);
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

/** The state as status and wait see it: the pause file reports `paused` until the workflow ends. */
function effectiveState(p: Paths, state: State): State {
  const paused = existsSync(p.pause) && state.status !== "stopped" && state.status !== "failed";
  return paused ? { ...state, status: "paused" as Status, reason: "" } : state;
}

/** `gdt status <n>`. The pause file reports `paused` even before the supervisor notices it. */
export function status(issue: number, cwd: string, env: Env, json: boolean): CommandResult {
  const root = findRepository(cwd) ?? cwd;
  const p = paths(root, issue, env);
  const state = readState(p);
  if (state === null) {
    // AC-5: the same keys, null without a dispatched turn.
    const empty = { issue, status: null, turn_started_at: null, turn_deadline: null, next_step: `gdt start ${issue}` };
    return json ? { code: 1, stdout: `${JSON.stringify(empty, null, 2)}\n`, stderr: "" } : fail(`No workflow for #${issue}. Next: gdt start ${issue}\n`);
  }
  const effective = effectiveState(p, state);
  const { line, next } = describe(effective, lockHolder(p) !== null);
  if (!json) return ok(`${line}. Next: ${next}\n`);

  let maxRounds: number | null = null;
  let turnTimeoutMinutes = DEFAULT_TURN_TIMEOUT_MINUTES;
  const { report } = loadConfig(root, env);
  if (report.valid) {
    maxRounds = report.workflow.max_correction_rounds;
    turnTimeoutMinutes = report.workflow.turn_timeout_minutes;
  }
  // AC-5: the in-flight turn's start and deadline, null without one.
  const inflight = state.inflight;
  const out = {
    issue,
    workflow_id: state.workflow_id,
    status: effective.status,
    reason: effective.reason,
    role: state.role,
    round: state.round,
    max_rounds: maxRounds,
    exit_code: state.exit_code,
    pr_number: state.pr_number,
    open_findings: state.open_findings ?? [],
    turn_started_at: inflight?.dispatched_at ?? null,
    turn_deadline: inflight === null ? null : turnDeadline(inflight.dispatched_at, turnTimeoutMinutes).toISOString(),
    overrides: readOverrides(p),
    next_step: next,
  };
  return ok(`${JSON.stringify(out, null, 2)}\n`);
}

export interface WaitOptions {
  json: boolean;
  /** Seconds to wait before giving up; null waits until the workflow needs attention. */
  timeoutSeconds: number | null;
}

/**
 * `gdt wait <n>`: blocks on the local workflow state only (no gh, no model tokens) and returns with
 * the `gdt status` output as soon as the workflow reaches an action status. It also returns when the
 * supervisor dies in a waiting status, because that is an event the operator must relay (AC-4).
 */
export function wait(issue: number, cwd: string, env: Env, options: WaitOptions): CommandResult {
  const root = findRepository(cwd) ?? cwd;
  const p = paths(root, issue, env);
  const deadline = options.timeoutSeconds === null ? null : Date.now() + options.timeoutSeconds * 1000;
  for (;;) {
    const state = readState(p);
    // No workflow is status's error path (AC-6); an action status returns at once (AC-1, AC-2).
    if (state === null) return status(issue, cwd, env, options.json);
    const effective = effectiveState(p, state);
    if (ACTION_STATUSES.includes(effective.status)) return status(issue, cwd, env, options.json);
    // A dead supervisor ends the wait, except while the operator paused it deliberately (AC-4).
    // A deliberate stop is not a dead supervisor: its final state follows once the stop window ends.
    if (effective.status !== "paused" && lockHolder(p) === null && !stopInProgress(p)) return status(issue, cwd, env, options.json);
    if (deadline !== null && Date.now() >= deadline) {
      return fail(`still ${effective.status} after ${options.timeoutSeconds} s. Next: gdt wait ${issue}\n`);
    }
    sleepSync(WAIT_POLL_MS);
  }
}
