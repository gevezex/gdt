import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Agent, Role } from "./config.js";
import type { InvalidRecord } from "./protocol.js";

type Env = Record<string, string | undefined>;

export const STATUSES = [
  "starting",
  "running",
  "paused",
  "awaiting_human",
  "waiting_for_checks",
  "ready_to_merge",
  "blocked",
  "contract_changed",
  "failed",
  "stopped",
] as const;
export type Status = (typeof STATUSES)[number];

/** A per-issue agent/model choice; takes precedence over the config role from the next turn. */
export interface AgentOverride {
  agent: Agent;
  model: string;
}

/** Statuses that notify the user when the workflow enters them. */
export const NOTIFY_STATUSES: readonly Status[] = ["awaiting_human", "blocked", "failed", "ready_to_merge"];

export interface Inflight {
  key: string;
  role: Role;
  round: number;
  dispatched_at: string;
  /** Highest comment id seen at dispatch; the handoff is a newer comment (ids only grow on GitHub). */
  after_comment_id: number;
  /** Fresh GitHub checks made for the handoff after the agent exited 0. */
  checks: number;
  /** Set when the handoff never became visible; the key stays blocked until a retry. */
  missing: boolean;
  /** AC-1: the blocked reason of that handoff, so a restart reports it again. */
  missing_reason?: string;
  /** AC-1: set once the turn passed its deadline; the block stays until a retry, a late result is ignored. */
  timed_out?: boolean;
  /** Set when the turn broke a role boundary; the key stays blocked until a retry. */
  violation?: string;
}

/** `.git/gdt/issue-<n>/state.json`. Written only by the supervisor, or by the CLI when no supervisor runs. */
export interface State {
  version: 1;
  issue: number;
  workflow_id: string;
  status: Status;
  reason: string;
  role: Role | null;
  round: number | null;
  exit_code: number | null;
  repository: string;
  pr_number: number | null;
  head: string | null;
  head_transition_at: string | null;
  contract: { sha256: string; changelog: string } | null;
  dispatched: string[];
  inflight: Inflight | null;
  /** The dispatch key of an already-ran block; `gdt retry` removes it from `dispatched`. */
  blocked_key?: string | null;
  /** AC-2: the invalid record of the last blocked turn, passed to that role's retried prompt. */
  retry_record?: InvalidRecord | null;
  notified_status: Status | null;
  /** Per role, the highest comment id seen at its previous dispatch; later directives are pending. */
  directive_cursor?: Partial<Record<Role, number>>;
  /** Blocking finding ids of the tester/reviewer evidence for the current head. */
  open_findings?: string[];
  pids: { supervisor: number | null; workers: Partial<Record<Role, number>> };
  updated_at: string;
}

export interface Paths {
  root: string;
  dir: string;
  state: string;
  lock: string;
  /** Existence means the workflow is paused; written by `gdt pause`, removed by `gdt resume`. */
  pause: string;
  /** Holds the pid of a running `gdt stop` or `gdt retry`; its stop window is not a dead supervisor. */
  stopping: string;
  /** Per-issue agent/model overrides written by `gdt set-agent`, kept out of `state.json`. */
  overrides: string;
  logs: string;
  /** `.git/gdt/issue-<n>/panes.json`: the terminal backend's panes, when it has any. */
  panes: string;
  /** `.git/gdt/issue-<n>/pids`: one file per pane holding its gdt process id. */
  pids: string;
  dispatch: (role: Role) => string;
  started: (key: string) => string;
  result: (key: string) => string;
  prompt: (key: string) => string;
}

/** The repository's common Git directory, so worktrees share one state. */
function gitDir(root: string, env: Env): string {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, env, encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim() !== "") return resolve(root, result.stdout.trim());
  return join(root, ".git");
}

export function paths(root: string, issue: number, env: Env): Paths {
  const dir = join(gitDir(root, env), "gdt", `issue-${issue}`);
  return {
    root,
    dir,
    state: join(dir, "state.json"),
    lock: join(dir, "supervisor.lock"),
    pause: join(dir, "paused"),
    stopping: join(dir, "stopping"),
    overrides: join(dir, "overrides.json"),
    logs: join(dir, "logs"),
    panes: join(dir, "panes.json"),
    pids: join(dir, "pids"),
    dispatch: (role) => join(dir, "dispatch", `${role}.json`),
    started: (key) => join(dir, "runs", `${key}.started`),
    result: (key) => join(dir, "runs", `${key}.result.json`),
    prompt: (key) => join(dir, "runs", `${key}.prompt.md`),
  };
}

/** A log line timestamp in local time, `YYYY-MM-DD hh:mm:ss`. */
export function logTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** Writes via a temporary file and rename, so readers never see a partial file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readState(p: Paths): State | null {
  return readJson<State>(p.state);
}

/** The per-issue agent/model overrides, empty when none are set. */
export function readOverrides(p: Paths): Partial<Record<Role, AgentOverride>> {
  return readJson<Partial<Record<Role, AgentOverride>>>(p.overrides) ?? {};
}

export function writeState(p: Paths, state: State, now: Date = new Date()): void {
  state.updated_at = now.toISOString();
  writeJsonAtomic(p.state, state);
}

export function alive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid in the lock file if that process is alive. */
export function lockHolder(p: Paths): number | null {
  if (!existsSync(p.lock)) return null;
  const pid = Number(readFileSync(p.lock, "utf8").trim());
  return Number.isInteger(pid) && alive(pid) ? pid : null;
}

/** Takes the per-issue supervisor lock; returns the holder's pid when another live process has it. */
export function acquireLock(p: Paths): number | null {
  mkdirSync(p.dir, { recursive: true });
  try {
    writeFileSync(p.lock, `${process.pid}\n`, { flag: "wx" });
    return null;
  } catch {
    // The lock file exists: honour it only while its process is alive.
  }
  const holder = lockHolder(p);
  if (holder !== null && holder !== process.pid) return holder;
  const tmp = `${p.lock}.${process.pid}.tmp`;
  writeFileSync(tmp, `${process.pid}\n`);
  renameSync(tmp, p.lock);
  return null;
}
