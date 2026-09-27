import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { adapterFor, type Invocation } from "./agents/index.js";
import { loadConfig, type ResolvedRole, type Role, TEST_AGENT, testAgentsEnabled } from "./config.js";
import { changedFiles, type Checkout, checkout } from "./git.js";
import { buildPrompt } from "./prompts.js";
import { alive, logTimestamp, paths, readJson, readOverrides, readState, writeJsonAtomic } from "./state.js";
import type { Dispatch, TurnResult } from "./supervisor.js";

type Env = Record<string, string | undefined>;

/** The command for one unattended turn: the role's agent adapter, or the test agent's script. */
export function invocation(roleName: Role, role: ResolvedRole, root: string, promptFile: string, env: Env): Invocation {
  if (role.agent === TEST_AGENT) {
    if (role.script === undefined || !testAgentsEnabled(env)) throw new Error(`agent "${TEST_AGENT}" requires GDT_TEST_AGENTS=1 and a script`);
    return { argv: ["/bin/sh", resolve(root, role.script)], env: { GDT_PROMPT_FILE: promptFile }, stdin: null };
  }
  const adapter = adapterFor(role.agent);
  if (adapter === undefined) throw new Error(`no adapter for agent "${role.agent}" yet`);
  return adapter.buildInvocation(roleName, role.model, promptFile, root);
}

function log(line: string): void {
  process.stdout.write(`${logTimestamp()} ${line}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** The turn's agent process, so a stop can end it with the worker. */
let activeAgent: ChildProcess | null = null;

/** AC-6: stops the running agent (and its own children) before the worker exits. */
function killAgent(): void {
  const child = activeAgent;
  if (child === null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

export function stopLine(issue: number): string {
  return `gdt stopped. Resume with: gdt start ${issue}`;
}

export function completeLine(issue: number): string {
  return `Workflow complete: #${issue} is ready to merge. This pane can be closed.`;
}

/** A tester or reviewer must leave tracked files, the branch and HEAD as they were. */
export function boundaryViolation(role: Role, before: Checkout, root: string, env: Env): string | undefined {
  if (role === "developer") return undefined;
  const changed = changedFiles(root, env, false);
  if (changed.length > 0) return `${role} changed tracked files: ${changed.join(", ")}`;
  const after = checkout(root, env);
  const name = (branch: string) => (branch === "" ? "(detached)" : branch);
  if (after.branch !== before.branch) return `${role} switched branch from ${name(before.branch)} to ${name(after.branch)}`;
  if (after.head !== before.head) return `${role} moved HEAD from ${before.head} to ${after.head}`;
  return undefined;
}

/** Runs one invocation and passes the agent's exit code through unchanged (null when killed by a signal). */
export function runInvocation(inv: Invocation, cwd: string, env: Env): Promise<number | null> {
  const [command, ...args] = inv.argv;
  return new Promise((done) => {
    let stdin: number | "ignore" = "ignore";
    try {
      if (inv.stdin !== null) stdin = openSync(inv.stdin, "r");
    } catch (err) {
      log(`cannot open prompt file: ${err instanceof Error ? err.message : String(err)}`);
      done(66);
      return;
    }
    // Its own process group, so a stop can end the agent and the children it started.
    const child = spawn(command ?? "", args, {
      cwd,
      env: { ...env, ...inv.env },
      stdio: [stdin, "inherit", "inherit"],
      detached: true,
    });
    activeAgent = child;
    const close = () => {
      if (typeof stdin === "number") closeSync(stdin);
    };
    child.on("error", (err) => {
      activeAgent = null;
      log(`agent could not start: ${err.message}`);
      close();
      done(127);
    });
    child.on("close", (code) => {
      activeAgent = null;
      close();
      done(code);
    });
  });
}

async function turn(root: string, role: Role, dispatch: Dispatch, env: Env, p: ReturnType<typeof paths>): Promise<void> {
  const finish = (exit_code: number | null, violation?: string) => {
    const result: TurnResult = { key: dispatch.key, exit_code, finished_at: new Date().toISOString() };
    if (violation !== undefined) result.violation = violation;
    writeJsonAtomic(p.result(dispatch.key), result);
    log(`turn ${dispatch.key} finished with exit code ${exit_code}`);
  };

  const started = p.started(dispatch.key);
  mkdirSync(dirname(started), { recursive: true });
  try {
    // Exclusive create: at most one run per dispatch key, even across restarts.
    writeFileSync(started, `${process.pid}\n`, { flag: "wx" });
  } catch {
    // Started before but never finished: the earlier run was interrupted. Never run it again.
    finish(null);
    return;
  }

  const { report } = loadConfig(root, env);
  if (!report.valid) {
    log("invalid config; run gdt doctor");
    finish(78);
    return;
  }
  const promptFile = p.prompt(dispatch.key);
  try {
    writeFileSync(promptFile, buildPrompt(role, dispatch, { root, extraRules: report.contract.extra_rules }));
  } catch (err) {
    log(`cannot build the prompt: ${err instanceof Error ? err.message : String(err)}`);
    finish(78);
    return;
  }

  // A `gdt set-agent` override wins over `.gdt/config.toml` for this role from this turn on.
  const override = readOverrides(p)[role];
  const roleConfig: ResolvedRole = override === undefined ? report.roles[role] : { ...report.roles[role], agent: override.agent, model: override.model };

  let inv: Invocation;
  try {
    inv = invocation(role, roleConfig, root, promptFile, env);
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    finish(127);
    return;
  }

  log(`turn ${dispatch.key}: ${inv.argv.join(" ")}`);
  const turnEnv: Env = {
    ...env,
    GDT_ISSUE: String(dispatch.issue),
    GDT_REPOSITORY: dispatch.repository,
    GDT_ROLE: role,
    GDT_ROUND: String(dispatch.round),
    GDT_PR: dispatch.pr_number === null ? "" : String(dispatch.pr_number),
    GDT_HEAD: dispatch.head ?? "",
    GDT_ISSUE_BODY_SHA256: dispatch.issue_body_sha256,
    GDT_DISPATCH_KEY: dispatch.key,
  };
  const before = checkout(root, env);
  const exitCode = await runInvocation(inv, root, turnEnv);
  const violation = boundaryViolation(role, before, root, env);
  if (violation !== undefined) log(violation);
  finish(exitCode, violation);
}

/** Waits for dispatches for `role` without a model and runs one agent turn per dispatch key. */
export async function work(root: string, issue: number, role: Role, env: Env): Promise<number> {
  const p = paths(root, issue, env);
  process.on("SIGTERM", () => {
    killAgent();
    process.stdout.write(`${stopLine(issue)}\n`);
    process.exit(143);
  });
  log(`${role} worker ${process.pid} for #${issue} waiting`);
  // In headless mode the workers keep waiting after ready_to_merge, as the supervisor does.
  const { report } = loadConfig(root, env);
  const herdr = report.valid && report.workflow.terminal === "herdr";
  for (;;) {
    const state = readState(p);
    // AC-7: the workflow is done; the final line explains that this pane can be closed.
    if (herdr && state !== null && state.status === "ready_to_merge") {
      log(`${role} worker exiting (workflow ${state.status})`);
      process.stdout.write(`${completeLine(issue)}\n`);
      return 0;
    }
    if (state === null || state.status === "failed" || state.status === "stopped" || !alive(state.pids.supervisor)) {
      log(`${role} worker exiting (workflow ${state?.status ?? "missing"})`);
      // AC-6: a worker that is alive when its workflow stops (or its supervisor disappears)
      // explains how to resume. A failed turn keeps its error and prints nothing extra.
      if (state !== null && state.status !== "failed") process.stdout.write(`${stopLine(issue)}\n`);
      return 0;
    }
    const dispatch = readJson<Dispatch>(p.dispatch(role));
    if (dispatch !== null && !existsSync(p.result(dispatch.key))) await turn(root, role, dispatch, env, p);
    await sleep(250);
  }
}
