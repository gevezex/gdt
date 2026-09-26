import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { adapterFor, type Invocation } from "./agents/index.js";
import { loadConfig, type ResolvedRole, type Role, TEST_AGENT, testAgentsEnabled } from "./config.js";
import { alive, paths, readJson, readState, writeJsonAtomic } from "./state.js";
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
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Minimal per-turn prompt: the dispatch facts. Role instructions are added by prompt construction (#6). */
function prompt(dispatch: Dispatch): string {
  return [
    `# gdt ${dispatch.role} turn`,
    "",
    `Repository: ${dispatch.repository}`,
    `Issue: #${dispatch.issue}`,
    `Round: ${dispatch.round}`,
    `Pull request: ${dispatch.pr_number === null ? "none" : `#${dispatch.pr_number}`}`,
    `Head: ${dispatch.head ?? "none"}`,
    `issue_body_sha256: ${dispatch.issue_body_sha256}`,
    `Acceptance criteria: ${dispatch.acceptance_criteria.join(", ")}`,
    "",
  ].join("\n");
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
    // Same process group as the worker, so stopping the worker stops the agent too.
    const child = spawn(command ?? "", args, { cwd, env: { ...env, ...inv.env }, stdio: [stdin, "inherit", "inherit"] });
    const close = () => {
      if (typeof stdin === "number") closeSync(stdin);
    };
    child.on("error", (err) => {
      log(`agent could not start: ${err.message}`);
      close();
      done(127);
    });
    child.on("close", (code) => {
      close();
      done(code);
    });
  });
}

async function turn(root: string, role: Role, dispatch: Dispatch, env: Env, p: ReturnType<typeof paths>): Promise<void> {
  const finish = (exit_code: number | null) => {
    const result: TurnResult = { key: dispatch.key, exit_code, finished_at: new Date().toISOString() };
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
  writeFileSync(promptFile, prompt(dispatch));

  let inv: Invocation;
  try {
    inv = invocation(role, report.roles[role], root, promptFile, env);
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
  finish(await runInvocation(inv, root, turnEnv));
}

/** Waits for dispatches for `role` without a model and runs one agent turn per dispatch key. */
export async function work(root: string, issue: number, role: Role, env: Env): Promise<number> {
  const p = paths(root, issue, env);
  log(`${role} worker ${process.pid} for #${issue} waiting`);
  for (;;) {
    const state = readState(p);
    if (state === null || state.status === "failed" || state.status === "stopped" || !alive(state.pids.supervisor)) {
      log(`${role} worker exiting (workflow ${state?.status ?? "missing"})`);
      return 0;
    }
    const dispatch = readJson<Dispatch>(p.dispatch(role));
    if (dispatch !== null && !existsSync(p.result(dispatch.key))) await turn(root, role, dispatch, env, p);
    await sleep(250);
  }
}
