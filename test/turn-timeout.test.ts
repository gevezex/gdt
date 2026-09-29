import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { alive, paths, type State, writeJsonAtomic, writeState } from "../src/state.js";
import { EXAMPLE_CONFIG, fakePath, gdt, tempRepo } from "./helpers.js";
import { FAKE_GH, gdt as gdtWorld, lines, stateOf, stopWorlds, supervisorLog, waitFor, world, type World } from "./world.js";

afterEach(stopWorlds);

const GIT_ENV = { PATH: process.env.PATH ?? "" };

/** A tester that records its own process id (the process-group leader) and then never exits. */
function sleepingTester(runsFile = "scripts/tester-runs", pidFile = "scripts/tester-agent.pid"): string {
  return `echo run >> ${runsFile}\necho $$ > ${pidFile}\n/bin/sleep 600\n`;
}

/** Waits until the tester has been dispatched and its agent has written its pid. */
async function waitForRunningTester(w: World, pidFile = join(w.root, "scripts/tester-agent.pid")): Promise<number> {
  await waitFor("the tester turn", () => stateOf(w).status === "running" && stateOf(w).role === "tester");
  await waitFor("the tester agent pid", () => existsSync(pidFile));
  return Number(readFileSync(pidFile, "utf8").trim());
}

/**
 * Makes every fake-gh call sleep, so on a restart the replacement worker writes its interruption
 * result before the supervisor's next poll. Without it the first poll usually wins the race, and the
 * regression it guards (a restart turning an overdue turn `failed`) would not show.
 */
function slowGh(w: World, seconds = 0.4): void {
  writeFileSync(
    join(w.bin, "gh"),
    `#!/bin/sh\n/bin/sleep ${seconds}\nexec "${process.execPath}" "${FAKE_GH}" "${w.github}" "$@"\n`,
  );
  chmodSync(join(w.bin, "gh"), 0o755);
}

describe("AC-1: a turn that exceeds the time limit ends in blocked and its agent is stopped", { timeout: 30_000 }, () => {
  it("stops the tester agent and worker and blocks with the timeout reason", async () => {
    const w = world({
      pr: true,
      turnTimeoutMinutes: 0.02,
      turnIdleMinutes: 0.02,
      developer: "gh fake-record 40 handoff\nexit 0\n",
      tester: sleepingTester(),
    });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });

    await waitFor("the tester turn", () => stateOf(w).status === "running" && stateOf(w).role === "tester");
    const workerPid = stateOf(w).pids.workers.tester;
    const agentPid = await waitForRunningTester(w);
    const dispatchedAt = stateOf(w).inflight?.dispatched_at;
    expect(dispatchedAt).toBeTruthy();

    // AC-5: while the turn is in flight the status shows its start and its deadline.
    const running = JSON.parse(gdtWorld(w, "status", "12", "--json").stdout) as {
      turn_started_at: string | null;
      turn_deadline: string | null;
    };
    expect(running.turn_started_at).toBe(dispatchedAt);
    expect(running.turn_deadline).toBe(new Date(Date.parse(dispatchedAt as string) + 0.02 * 60_000).toISOString());

    const reason = "tester turn inactive for 0.02 minutes after the 0.02-minute limit";
    await waitFor("the timeout block", () => stateOf(w).reason === reason);
    const state = stateOf(w);
    expect(state.status).toBe("blocked");
    expect(state.role).toBe("tester");
    expect(state.round).toBe(0);

    // The role's worker and agent process group are stopped.
    await waitFor("the tester worker to stop", () => workerPid === undefined || !alive(workerPid));
    await waitFor("the tester agent to stop", () => !alive(agentPid));

    // gdt wait returns with the blocked status and gdt status points to the retry.
    const expected = `blocked: ${reason}. Next: gdt retry 12\n`;
    expect(gdtWorld(w, "wait", "12")).toMatchObject({ code: 0, stdout: expected });
    expect(gdtWorld(w, "status", "12").stdout).toBe(expected);

    // The notifier fired once for the block.
    const notifications = lines(join(w.bin, "notifications"));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain(reason);
  });
});

describe("AC-1: a GitHub failure does not postpone the timeout", { timeout: 30_000 }, () => {
  it("still blocks the turn and stops the agent while gh is unavailable", async () => {
    const w = world({
      pr: true,
      turnTimeoutMinutes: 0.02,
      turnIdleMinutes: 0.02,
      developer: "gh fake-record 40 handoff\nexit 0\n",
      tester: sleepingTester(),
    });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the tester turn", () => stateOf(w).status === "running" && stateOf(w).role === "tester");
    const agentPid = await waitForRunningTester(w);

    // GitHub becomes unavailable for the rest of the workflow. Finding R-1: the deadline check must
    // not depend on a successful `gh` call, or the hung turn stays `running` forever.
    writeFileSync(join(w.bin, "gh"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(w.bin, "gh"), 0o755);

    const reason = "tester turn inactive for 0.02 minutes after the 0.02-minute limit";
    await waitFor("the timeout block despite the gh failure", () => stateOf(w).reason === reason);
    expect(stateOf(w).status).toBe("blocked");
    await waitFor("the tester agent to stop", () => !alive(agentPid));
    expect(gdtWorld(w, "status", "12").stdout).toBe(`blocked: ${reason}. Next: gdt retry 12\n`);
    // The gh failure was real: polls were skipped, yet the timeout still fired.
    expect(supervisorLog(w)).toContain("poll failed:");
  });
});

describe("AC-1: a restarted supervisor blocks an overdue in-flight turn", { timeout: 60_000 }, () => {
  it("blocks with the timeout reason instead of failing when the turn is past its deadline", async () => {
    const w = world({
      pr: true,
      turnTimeoutMinutes: 0.02,
      turnIdleMinutes: 0.02,
      developer: "gh fake-record 40 handoff\nexit 0\n",
      tester: sleepingTester(),
    });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the tester turn", () => stateOf(w).status === "running" && stateOf(w).role === "tester");
    const key = stateOf(w).inflight?.key as string;
    await waitForRunningTester(w);

    // The issue assumption: an overdue turn blocks on a restarted supervisor's first poll. `gdt stop`
    // keeps the in-flight turn and its `started` marker but removes the worker that never wrote a
    // result. The slow fake gh keeps the poll behind the replacement worker, which would otherwise
    // write an interruption result and turn the restart into `failed` (finding R-1).
    await new Promise((done) => setTimeout(done, 1500));
    expect(gdtWorld(w, "stop", "12")).toMatchObject({ code: 0 });
    slowGh(w);
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });

    const reason = "tester turn inactive for 0.02 minutes after the 0.02-minute limit";
    await waitFor("the timeout block after the restart", () => stateOf(w).reason === reason);
    const state = stateOf(w);
    expect(state.status).toBe("blocked");
    expect(state.role).toBe("tester");
    expect(state.inflight).toMatchObject({ key, timed_out: true });
    // The overdue turn was settled before any replacement worker could write an interruption result.
    expect(existsSync(paths(w.root, 12, w.env).result(key))).toBe(false);
  });
});

describe("AC-2: a turn that finishes before the deadline is unaffected", { timeout: 30_000 }, () => {
  it("moves on to the tester and never sets a timeout reason", async () => {
    const w = world({
      pr: true,
      turnTimeoutMinutes: 0.05,
      developer: "/bin/sleep 1\ngh fake-record 40 handoff\nexit 0\n",
      handoffChecks: 10_000,
    });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });

    await waitFor("the developer turn", () => stateOf(w).status === "running" && stateOf(w).role === "developer");
    const developerStartedAt = stateOf(w).inflight?.dispatched_at as string;

    await waitFor("the tester turn", () => stateOf(w).status === "running" && stateOf(w).role === "tester");
    // Cross the developer's (3 s) deadline while the workflow has already moved on.
    const wait = Date.parse(developerStartedAt) + 0.05 * 60_000 + 500 - Date.now();
    if (wait > 0) await new Promise((done) => setTimeout(done, wait));

    expect(stateOf(w)).toMatchObject({ status: "running", role: "tester" });
    const log = supervisorLog(w);
    expect(log).toContain("dispatched developer");
    expect(log).toContain("dispatched tester");
    expect(log).not.toContain("inactive for");
  });
});

describe("AC-3: gdt retry recovers a timed-out turn without orphaned processes", { timeout: 30_000 }, () => {
  it("clears the turn and dispatches the same role and round again", async () => {
    const w = world({
      pr: true,
      turnTimeoutMinutes: 0.02,
      turnIdleMinutes: 0.02,
      developer: "gh fake-record 40 handoff\nexit 0\n",
      tester: sleepingTester(),
    });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });

    await waitFor("the tester turn", () => stateOf(w).status === "running" && stateOf(w).role === "tester");
    const workerPid = stateOf(w).pids.workers.tester;
    const agentPid = await waitForRunningTester(w);
    await waitFor("the timeout block", () => stateOf(w).status === "blocked" && stateOf(w).reason.includes("inactive for"));
    const key = stateOf(w).inflight?.key;

    expect(gdtWorld(w, "retry", "12")).toMatchObject({ code: 0, stdout: "Retry prepared for #12. Next: gdt start 12\n" });
    await waitFor("the tester worker to stop", () => workerPid === undefined || !alive(workerPid));
    await waitFor("the tester agent to stop", () => !alive(agentPid));
    const retried = stateOf(w);
    expect(retried.inflight).toBeNull();
    expect(retried.dispatched).not.toContain(key);

    // The same role and round run again; the first run already recorded one invocation.
    expect(readFileSync(join(w.root, "scripts/tester-runs"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the second tester turn", () => stateOf(w).status === "running" && stateOf(w).role === "tester");
    expect(stateOf(w).round).toBe(0);
    await waitFor("the second tester invocation", () => {
      const file = join(w.root, "scripts/tester-runs");
      return existsSync(file) && readFileSync(file, "utf8").trim().split("\n").length === 2;
    });
  });
});

describe("AC-4: the time limit is configurable and validated", () => {
  it("defaults to 60 when the key is absent", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    const result = gdt(["doctor", "--json"], root, fakePath());
    const report = JSON.parse(result.stdout) as { config: { workflow: { turn_timeout_minutes: number } } };
    expect(result.code).toBe(0);
    expect(report.config.workflow.turn_timeout_minutes).toBe(60);
  });

  it("uses a positive number as the limit", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG.replace('terminal = "herdr"', 'terminal = "herdr"\nturn_timeout_minutes = 1.5') });
    const result = gdt(["doctor", "--json"], root, fakePath());
    const report = JSON.parse(result.stdout) as { config: { workflow: { turn_timeout_minutes: number } } };
    expect(result.code).toBe(0);
    expect(report.config.workflow.turn_timeout_minutes).toBe(1.5);
  });

  it.each(["0", "-3", '"sixty"'])("rejects %s with an error naming workflow.turn_timeout_minutes", (value) => {
    const root = tempRepo({
      ".gdt/config.toml": EXAMPLE_CONFIG.replace('terminal = "herdr"', `terminal = "herdr"\nturn_timeout_minutes = ${value}`),
    });
    const result = gdt(["doctor", "--json"], root, fakePath());
    const report = JSON.parse(result.stdout) as { findings: { level: string; message: string }[] };
    expect(result.code).toBe(1);
    expect(report.findings.some((f) => f.level === "error" && f.message.includes("workflow.turn_timeout_minutes"))).toBe(true);
  });
});

describe("AC-5: gdt status --json shows the running turn's start and deadline", () => {
  function stateWith(over: Partial<State>): string {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    writeState(paths(root, 10, GIT_ENV), {
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
    });
    return root;
  }

  it("reports the dispatched_at and the deadline of the in-flight turn", () => {
    const root = stateWith({
      status: "running",
      role: "tester",
      round: 0,
      inflight: {
        key: "tester.r0.no-pr.abc",
        role: "tester",
        round: 0,
        dispatched_at: "2026-09-29T10:00:00.000Z",
        after_comment_id: 0,
        checks: 0,
        missing: false,
      },
    });
    const result = gdt(["status", "10", "--json"], root, fakePath());
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      turn_started_at: "2026-09-29T10:00:00.000Z",
      turn_deadline: "2026-09-29T11:00:00.000Z",
    });
  });

  it("reports null for both without an in-flight turn", () => {
    const root = stateWith({ status: "blocked", reason: "developer reported blocked" });
    const result = gdt(["status", "10", "--json"], root, fakePath());
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ turn_started_at: null, turn_deadline: null });
  });

  it("reports null for both once the worker wrote the turn's result file", () => {
    const key = "tester.r0.no-pr.abc";
    const root = stateWith({
      status: "blocked",
      role: "tester",
      round: 0,
      reason: "tester finished without a visible handoff",
      inflight: {
        key,
        role: "tester",
        round: 0,
        dispatched_at: "2026-09-29T10:00:00.000Z",
        after_comment_id: 0,
        checks: 5,
        missing: true,
      },
    });
    // A written result file ends the turn (issue Definitions), even while `inflight` is kept.
    writeJsonAtomic(paths(root, 10, GIT_ENV).result(key), { key, exit_code: 0, finished_at: "2026-09-29T10:00:05.000Z" });
    const result = gdt(["status", "10", "--json"], root, fakePath());
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ turn_started_at: null, turn_deadline: null });
  });
});

describe("AC-5: a finished turn reports no start or deadline while awaiting its handoff", { timeout: 30_000 }, () => {
  it("reports null once the worker wrote its result file and the handoff check waits", async () => {
    const w = world({ pr: true, developer: "exit 0\n", handoffChecks: 2 });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the missing handoff block", () => stateOf(w).status === "blocked");
    expect(stateOf(w).reason).toBe("developer finished without a visible handoff");
    // Finding R-2: the supervisor keeps `inflight` during the handoff check, but the turn has ended.
    expect(stateOf(w).inflight).not.toBeNull();
    const out = JSON.parse(gdtWorld(w, "status", "12", "--json").stdout) as {
      turn_started_at: string | null;
      turn_deadline: string | null;
    };
    expect(out.turn_started_at).toBeNull();
    expect(out.turn_deadline).toBeNull();
  });
});
