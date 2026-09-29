import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

type Env = Record<string, string | undefined>;

/** The CPU signal fires when the agent process group used at least this many more CPU seconds. */
export const CPU_SIGNAL_SECONDS = 1;

/** One activity sample of a result-less in-flight turn (issue Definitions). */
export interface ActivitySample {
  /** Summed CPU seconds of the live processes in the agent process group. */
  cpu: number;
  /** Number of live processes in the agent process group; null when `ps` could not be read. */
  processes: number | null;
  /** SHA-256 of the working tree fingerprint, or null when git could not read it. */
  tree: string | null;
  /** Size of the headless role log in bytes; null in herdr mode. */
  log: number | null;
  /** Mtime in ms of the opencode session database; null when the role's agent is not opencode. */
  opencode: number | null;
}

/** The sample values kept in state, so the next poll (or a restarted supervisor) compares against them. */
export interface ActivityBaseline {
  /** CPU seconds at the last recorded activity. */
  cpu: number;
  tree: string | null;
  log: number | null;
  opencode: number | null;
}

export interface Signals {
  cpu: boolean;
  tree: boolean;
  log: boolean;
  opencode: boolean;
}

/** Parses a `ps` `time` value: `[dd-]hh:mm:ss` on Linux, `m:ss.cc` or `h:mm:ss.cc` on macOS. */
export function parseCpuTime(value: string): number {
  const [days, rest] = value.includes("-") ? value.split("-", 2) : ["0", value];
  const parts = (rest ?? "").split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + (Number.isFinite(part) ? part : 0);
  return Number(days) * 86_400 + seconds;
}

/**
 * The summed CPU time and number of live (non-zombie) processes of process group `pgid`. The count is
 * null when `ps` fails, so an unreadable process table never looks like an exited agent.
 */
export function groupUsage(pgid: number | null, env: Env): { cpu: number; processes: number | null } {
  if (pgid === null || pgid <= 0) return { cpu: 0, processes: 0 };
  const result = spawnSync("ps", ["-A", "-o", "pgid=", "-o", "stat=", "-o", "time="], { env, encoding: "utf8" });
  if (result.status !== 0) return { cpu: 0, processes: null };
  let cpu = 0;
  let processes = 0;
  for (const line of result.stdout.split("\n")) {
    const [group, stat, time] = line.trim().split(/\s+/);
    if (Number(group) !== pgid || stat === undefined || time === undefined || stat.startsWith("Z")) continue;
    processes += 1;
    cpu += parseCpuTime(time);
  }
  return { cpu, processes };
}

/** `HEAD`, `git status --porcelain` and the mtime of every listed file, hashed. */
export function treeFingerprint(root: string, env: Env): string | null {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
  const head = git("rev-parse", "HEAD");
  const status = git("status", "--porcelain", "-z");
  if (status.status !== 0) return null;
  const hash = createHash("sha256").update(head.status === 0 ? head.stdout : "").update("\0").update(status.stdout);
  const entries = status.stdout.split("\0").filter((entry) => entry !== "");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    const path = entry.slice(3);
    // A rename or copy is followed by its original path, which no longer exists as listed.
    if (entry[0] === "R" || entry[0] === "C") i += 1;
    hash.update(`\0${path}\0${mtimeOf(join(root, path)) ?? "-"}`);
  }
  return hash.digest("hex");
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** The opencode session database: `$XDG_DATA_HOME/opencode/opencode.db`, by default under `~/.local/share`. */
export function opencodeDatabase(env: Env, home: string): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".local", "share");
  return join(base, "opencode", "opencode.db");
}

/** The mtime of `opencode.db-wal`, or of `opencode.db` when there is no write-ahead log. */
export function opencodeMtime(database: string): number | null {
  return mtimeOf(`${database}-wal`) ?? mtimeOf(database);
}

export interface SampleInput {
  root: string;
  env: Env;
  pgid: number | null;
  /** The headless role log, or null in herdr mode. */
  logFile: string | null;
  /** The opencode database, or null when the role's agent is not opencode. */
  opencodeDb: string | null;
}

/** Reads one activity sample with `ps`, `git` and file metadata only. */
export function sample(input: SampleInput): ActivitySample {
  const usage = groupUsage(input.pgid, input.env);
  return {
    cpu: usage.cpu,
    processes: usage.processes,
    tree: treeFingerprint(input.root, input.env),
    log: input.logFile === null ? null : (sizeOf(input.logFile) ?? 0),
    opencode: input.opencodeDb === null ? null : opencodeMtime(input.opencodeDb),
  };
}

/**
 * Compares a sample with the stored baseline. Without a baseline (the turn's first sample) no signal
 * fires except CPU, which counts from zero: the agent process group started without CPU time.
 */
export function signals(current: ActivitySample, baseline: ActivityBaseline | undefined): Signals {
  const cpuBase = baseline?.cpu ?? 0;
  const changed = <T>(now: T | null, before: T | null | undefined) =>
    baseline !== undefined && now !== null && before !== null && before !== undefined && now !== before;
  return {
    cpu: current.cpu - cpuBase >= CPU_SIGNAL_SECONDS,
    tree: changed(current.tree, baseline?.tree),
    log: baseline !== undefined && current.log !== null && current.log > (baseline.log ?? 0),
    opencode:
      baseline !== undefined && current.opencode !== null && (baseline.opencode === null || current.opencode > baseline.opencode),
  };
}

/**
 * The baseline for the next poll. The CPU value only moves with recorded activity, or down when a
 * process of the group exits and takes its CPU time with it.
 */
export function nextBaseline(current: ActivitySample, previous: ActivityBaseline | undefined, active: boolean): ActivityBaseline {
  const cpuBase = previous?.cpu ?? 0;
  return {
    cpu: active || current.cpu < cpuBase ? current.cpu : cpuBase,
    tree: current.tree,
    log: current.log,
    opencode: current.opencode,
  };
}

/** The `supervisor.log` fragment naming every signal and whether it fired, for example `cpu=yes tree=no`. */
export function formatSignals(fired: Signals): string {
  const yn = (value: boolean) => (value ? "yes" : "no");
  return `cpu=${yn(fired.cpu)} tree=${yn(fired.tree)} log=${yn(fired.log)} opencode=${yn(fired.opencode)}`;
}
