import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { paths, writeState, type State } from "../src/state.js";
import { EXAMPLE_CONFIG, fakePath, gdt, tempRepo } from "./helpers.js";
import { CLI, gdt as gdtWorld, lockPid, sleep, stateOf, stopWorlds, waitFor, world } from "./world.js";

afterEach(stopWorlds);

/** An environment with only git on PATH, for tests that drive `.git/gdt/` state by hand. */
const GIT_ENV = { PATH: process.env.PATH ?? "" };

/** The six statuses the issue calls action statuses: `gdt wait` must return at each of them. */
const ACTION_STATUSES = ["awaiting_human", "blocked", "failed", "ready_to_merge", "contract_changed", "stopped"] as const;

function baseState(over: Partial<State>): State {
  return {
    version: 1,
    issue: 10,
    workflow_id: "a1b2c3",
    status: "running",
    reason: "",
    role: null,
    round: 1,
    exit_code: null,
    repository: "gevezex/demo",
    pr_number: 25,
    head: null,
    head_transition_at: null,
    contract: null,
    dispatched: [],
    inflight: null,
    notified_status: null,
    pids: { supervisor: null, workers: {} },
    updated_at: "",
    ...over,
  };
}

interface WaitRun {
  child: ChildProcess;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/** Runs `gdt wait` as a background process so the test can change the state while it blocks. */
function startWait(cwd: string, env: Record<string, string>, args: string[]): WaitRun {
  const child = spawn(process.execPath, [CLI, "wait", ...args], { cwd, env });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

describe("AC-1: wait returns when the workflow reaches an action status", { timeout: 30_000 }, () => {
  it("returns 0 with the status output within 2 seconds after gdt stop makes it stopped", async () => {
    const w = world({ developer: "/bin/sleep 60\n", handoffChecks: 10_000 });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("running", () => stateOf(w).status === "running");

    const waiter = startWait(w.root, w.env, ["12"]);
    await sleep(300);
    const changedAt = Date.now();
    expect(gdtWorld(w, "stop", "12").code).toBe(0);

    const result = await waiter.done;
    expect(Date.now() - changedAt).toBeLessThan(2000);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("stopped. Next: gdt start 12\n");
  });

  it("never reports the supervisor as gone while a deliberate stop is still settling", async () => {
    const w = world({ developer: "/bin/sleep 60\n", handoffChecks: 10_000 });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("running", () => stateOf(w).status === "running");

    const lock = join(w.root, ".git/gdt/issue-12/supervisor.lock");
    const stopRun = spawn(process.execPath, [CLI, "stop", "12"], { cwd: w.root, env: w.env });
    const stopState: { code: number | null; exited: boolean } = { code: null, exited: false };
    stopRun.on("exit", (value) => {
      stopState.code = value;
      stopState.exited = true;
    });

    // Sample while `gdt stop` runs: every moment the lock is absent, the state must already be an
    // action status. Otherwise a concurrent `gdt wait` would mistake a deliberate stop for a dead
    // supervisor (AC-4) and report "supervisor not running" instead of "stopped" (AC-1).
    const actions = new Set<string>(ACTION_STATUSES);
    const wrong: string[] = [];
    while (!stopState.exited) {
      if (!existsSync(lock)) wrong.push(stateOf(w).status);
      await sleep(1);
    }

    expect(stopState.code).toBe(0);
    expect(wrong.filter((status) => !actions.has(status))).toEqual([]);
    expect(stateOf(w).status).toBe("stopped");
  });

  it("returns awaiting_human when the developer asks a question", async () => {
    const w = world({ developer: "/bin/sleep 2\ngh fake-record 12 question\nexit 0\n", handoffChecks: 10_000 });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });

    const waiter = startWait(w.root, w.env, ["12"]);
    await waitFor("awaiting_human", () => stateOf(w).status === "awaiting_human");
    const changedAt = Date.now();

    const result = await waiter.done;
    expect(Date.now() - changedAt).toBeLessThan(2000);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('awaiting_human: waiting for an answer to Q1. Next: gdt answer 12 <question-id> "<answer>"\n');
  });
});

describe("AC-2: wait returns at once for an action status", () => {
  it.each(ACTION_STATUSES)("prints the same output as gdt status for %s", (status) => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    writeState(paths(root, 10, GIT_ENV), baseState({ status, reason: "some reason" }));

    const now = gdt(["wait", "10", "--json"], root, fakePath());
    const real = gdt(["status", "10", "--json"], root, fakePath());
    expect(now.code).toBe(0);
    expect(now.stdout).toBe(real.stdout);
    expect(JSON.parse(now.stdout).status).toBe(status);
  });

  it("prints the human status output without --json", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    writeState(paths(root, 10, GIT_ENV), baseState({ status: "ready_to_merge", reason: "all gates passed" }));

    const now = gdt(["wait", "10"], root, fakePath());
    const real = gdt(["status", "10"], root, fakePath());
    expect(now.code).toBe(0);
    expect(now.stdout).toBe(real.stdout);
    expect(now.stdout).toBe("ready_to_merge: all gates passed. Next: review and merge pull request #25\n");
  });
});

describe("AC-3: wait keeps waiting in a waiting status", () => {
  it("does not return while a live supervisor moves between waiting statuses", async () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    const p = paths(root, 10, GIT_ENV);
    const running = baseState({ status: "running", role: "developer" });
    writeState(p, running);
    mkdirSync(dirname(p.lock), { recursive: true });
    // The test process stands in for a live supervisor; wait only checks that the lock holder is alive.
    writeFileSync(p.lock, `${process.pid}\n`);

    const waiter = startWait(root, GIT_ENV, ["10"]);
    try {
      await sleep(300);
      for (const status of ["waiting_for_checks", "paused", "running"] as const) {
        writeState(p, { ...running, status });
        await sleep(300);
        expect(waiter.child.exitCode).toBeNull();
      }
      writeState(p, { ...running, status: "stopped" });
      const result = await waiter.done;
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("stopped. Next: gdt start 10\n");
    } finally {
      rmSync(p.lock, { force: true });
      if (waiter.child.exitCode === null) waiter.child.kill("SIGKILL");
    }
  });
});

describe("AC-4: wait returns when the supervisor dies", { timeout: 30_000 }, () => {
  it("returns 0 with the supervisor-not-running status after the supervisor is killed", async () => {
    const w = world({ developer: "/bin/sleep 60\n", handoffChecks: 10_000 });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("running", () => stateOf(w).status === "running");
    const pid = lockPid(w);
    expect(pid).not.toBeNull();

    const waiter = startWait(w.root, w.env, ["12"]);
    await sleep(300);
    process.kill(pid as number, "SIGKILL");

    const result = await waiter.done;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("supervisor not running (last status: running). Next: gdt start 12\n");
  });

  it("keeps waiting while paused even without a live supervisor", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    writeState(paths(root, 10, GIT_ENV), baseState({ status: "paused" }));

    const result = gdt(["wait", "10", "--timeout", "1"], root, fakePath());
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("still paused after 1 s. Next: gdt wait 10\n");
  });
});

describe("AC-5: wait stops after an optional timeout", { timeout: 30_000 }, () => {
  it("exits 1 naming the status and gdt wait as the next step", async () => {
    const w = world({ developer: "/bin/sleep 60\n", handoffChecks: 10_000 });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("running", () => stateOf(w).status === "running");

    const began = Date.now();
    const result = gdtWorld(w, "wait", "12", "--timeout", "1");
    expect(result.code).toBe(1);
    expect(Date.now() - began).toBeGreaterThanOrEqual(1000);
    expect(result.stderr).toBe("still running after 1 s. Next: gdt wait 12\n");
  });
});

describe("AC-6: wait without a workflow fails like status", () => {
  it("exits 1 at once with the same output as gdt status", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });

    const real = gdt(["status", "10"], root, fakePath());
    const now = gdt(["wait", "10"], root, fakePath());
    expect(now.code).toBe(1);
    expect(now.stderr).toBe(real.stderr);
    expect(now.stderr).toBe("No workflow for #10. Next: gdt start 10\n");
  });

  it("prints the same JSON as gdt status with --json", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });

    const real = gdt(["status", "10", "--json"], root, fakePath());
    const now = gdt(["wait", "10", "--json"], root, fakePath());
    expect(now.code).toBe(1);
    expect(now.stdout).toBe(real.stdout);
    expect(JSON.parse(now.stdout).status).toBeNull();
  });
});

describe("AC-7: the operator skill and design use wait", () => {
  const skill = readFileSync("skill/SKILL.md", "utf8");
  const design = readFileSync("docs/design.md", "utf8");

  it("skill/SKILL.md tells the operator to run gdt wait after gdt start", () => {
    expect(skill).toContain("gdt wait <issue>");
    expect(skill).toMatch(/background task whose completion wakes you/i);
    expect(skill).toMatch(/relay that result to the user/i);
    expect(skill).toMatch(/never repeat `gdt status` from model turns to wait/i);
  });

  it("design section 2.2 tells the operator to run gdt wait after gdt start", () => {
    expect(design).toContain("gdt wait <n>");
    expect(design).toMatch(/background task whose completion wakes/i);
    expect(design).toMatch(/relays the result to the user/i);
    expect(design).toMatch(/never repeats `gdt status` from model turns to wait/i);
  });
});
