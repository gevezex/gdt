import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { groupUsage, nextBaseline, parseCpuTime, signals } from "../src/activity.js";
import { alive, paths, type State, writeState } from "../src/state.js";
import { EXAMPLE_CONFIG, fakePath, gdt, tempRepo } from "./helpers.js";
import { gdt as gdtWorld, lines, sleep, stateOf, stopWorlds, supervisorLog, waitFor, world, type World } from "./world.js";

afterEach(stopWorlds);

const GIT_ENV = { PATH: process.env.PATH ?? "" };
const HANDOFF = "gh fake-record 40 handoff\nexit 0\n";
const PID_FILE = "scripts/agent.pid";

/** A fake agent that records its pid (the process-group leader) and then runs `body`. */
function agent(body: string): string {
  return `echo $$ > ${PID_FILE}\n${body}`;
}

/** Burns CPU in a loop until `scripts/finish` exists, then posts a test record and exits 0. */
const CPU_TESTER = agent(`while [ ! -f scripts/finish ]; do :; done\ngh fake-record 40 test\nexit 0\n`);
/** Sleeps without using CPU and without output. */
const SLEEPING = agent("/bin/sleep 600\n");

/** Waits until `role` runs and its fake agent has written its pid, and returns that pid. */
async function agentPid(w: World, role: "developer" | "tester"): Promise<number> {
  await waitFor(`the ${role} turn`, () => stateOf(w).status === "running" && stateOf(w).role === role);
  const file = join(w.root, PID_FILE);
  await waitFor(`the ${role} agent pid`, () => existsSync(file) && readFileSync(file, "utf8").trim() !== "");
  return Number(readFileSync(file, "utf8").trim());
}

/** Waits until `seconds` after the in-flight turn's deadline. */
async function pastDeadline(w: World, timeoutMinutes: number, seconds: number): Promise<void> {
  const dispatchedAt = Date.parse(stateOf(w).inflight?.dispatched_at as string);
  const wait = dispatchedAt + timeoutMinutes * 60_000 + seconds * 1000 - Date.now();
  if (wait > 0) await sleep(wait);
}

function statusJson(w: World): Record<string, unknown> {
  return JSON.parse(gdtWorld(w, "status", "12", "--json").stdout) as Record<string, unknown>;
}

/** The supervisor's activity-check lines. */
function activityLines(w: World): string[] {
  return supervisorLog(w)
    .split("\n")
    .filter((line) => line.includes("activity check for"));
}

describe("AC-1: an active turn past the deadline keeps running", { timeout: 30_000 }, () => {
  it("keeps a CPU-burning tester running and logs the signals of each poll", async () => {
    const w = world({ pr: true, turnTimeoutMinutes: 0.02, turnIdleMinutes: 0.05, turnMaxMinutes: 1, developer: HANDOFF, tester: CPU_TESTER });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    const pid = await agentPid(w, "tester");
    const workerPid = stateOf(w).pids.workers.tester as number;

    await pastDeadline(w, 0.02, 3);
    expect(alive(pid)).toBe(true);
    expect(alive(workerPid)).toBe(true);
    const out = statusJson(w);
    expect(out.status).toBe("running");
    expect(out.reason).toBe("tester turn past the 0.02-minute limit, still active");

    // Each line names every signal and whether it fired.
    const checks = activityLines(w);
    expect(checks.length).toBeGreaterThan(0);
    for (const line of checks) expect(line).toMatch(/cpu=(yes|no) tree=(yes|no) log=(yes|no) opencode=(yes|no)/);
    expect(checks.some((line) => line.includes("cpu=yes"))).toBe(true);
  });
});

describe("AC-2: an inactive turn past the deadline is stopped and blocked", { timeout: 30_000 }, () => {
  it("stops the sleeping tester, blocks with the inactivity reason and points to gdt retry", async () => {
    const w = world({ pr: true, turnTimeoutMinutes: 0.02, turnIdleMinutes: 0.02, developer: HANDOFF, tester: SLEEPING });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    const pid = await agentPid(w, "tester");
    const workerPid = stateOf(w).pids.workers.tester as number;

    const reason = "tester turn inactive for 0.02 minutes after the 0.02-minute limit";
    await waitFor("the inactivity block", () => stateOf(w).reason === reason);
    expect(statusJson(w)).toMatchObject({ status: "blocked", reason, next_step: "gdt retry 12" });

    // No process of the fake agent (the shell and its sleep) and not its worker is left.
    await waitFor("the tester worker to stop", () => !alive(workerPid));
    await waitFor("the agent process group to stop", () => groupUsage(pid, GIT_ENV).processes === 0);

    expect(gdtWorld(w, "wait", "12")).toMatchObject({ code: 0, stdout: `blocked: ${reason}. Next: gdt retry 12\n` });
    const notifications = lines(join(w.bin, "notifications"));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain(reason);

    expect(gdtWorld(w, "retry", "12")).toMatchObject({ code: 0, stdout: "Retry prepared for #12. Next: gdt start 12\n" });
    expect(stateOf(w).inflight).toBeNull();
  });
});

describe("AC-3: each activity signal on its own counts as activity", { timeout: 30_000 }, () => {
  it("keeps a sleeping developer running while it changes a tracked file", async () => {
    const w = world({
      turnTimeoutMinutes: 0.02,
      turnIdleMinutes: 0.05,
      developer: agent("while :; do echo x >> src/a.ts; /bin/sleep 2; done\n"),
      extraFiles: { "src/a.ts": "export {};\n" },
    });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    const pid = await agentPid(w, "developer");

    await pastDeadline(w, 0.02, 5);
    expect(alive(pid)).toBe(true);
    expect(stateOf(w)).toMatchObject({ status: "running", reason: "developer turn past the 0.02-minute limit, still active" });
    expect(activityLines(w).some((line) => line.includes("cpu=no tree=yes log=no opencode=no"))).toBe(true);
  });

  it("keeps a sleeping tester running while its headless output grows", async () => {
    const w = world({
      pr: true,
      turnTimeoutMinutes: 0.02,
      turnIdleMinutes: 0.05,
      developer: HANDOFF,
      tester: agent("while :; do echo tick; /bin/sleep 2; done\n"),
    });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    const pid = await agentPid(w, "tester");

    await pastDeadline(w, 0.02, 5);
    expect(alive(pid)).toBe(true);
    expect(stateOf(w)).toMatchObject({ status: "running", reason: "tester turn past the 0.02-minute limit, still active" });
    expect(activityLines(w).some((line) => line.includes("cpu=no tree=no log=yes opencode=no"))).toBe(true);
  });

  it("keeps a sleeping opencode tester running while it writes its session database", async () => {
    const data = mkdtempSync(join(tmpdir(), "gdt-xdg-data-"));
    mkdirSync(join(data, "opencode"));
    writeFileSync(join(data, "opencode", "opencode.db"), "");
    const w = world({
      pr: true,
      turnTimeoutMinutes: 0.02,
      turnIdleMinutes: 0.05,
      developer: HANDOFF,
      roleAgents: { tester: "opencode" },
      env: { XDG_DATA_HOME: data },
    });
    // The fake opencode writes only to the write-ahead log beside the database, never to stdout.
    writeFileSync(
      join(w.bin, "opencode"),
      `#!/bin/sh\n${agent('while :; do echo x >> "$XDG_DATA_HOME/opencode/opencode.db-wal"; /bin/sleep 2; done\n')}`,
    );
    chmodSync(join(w.bin, "opencode"), 0o755);
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    const pid = await agentPid(w, "tester");

    await pastDeadline(w, 0.02, 5);
    expect(alive(pid)).toBe(true);
    expect(stateOf(w)).toMatchObject({ status: "running", reason: "tester turn past the 0.02-minute limit, still active" });
    expect(activityLines(w).some((line) => line.includes("cpu=no tree=no log=no opencode=yes"))).toBe(true);
  });
});

/** A CPU-burning tester that reaches its 3-second hard limit. */
async function atHardLimit(): Promise<{ w: World; pid: number }> {
  const w = world({ pr: true, turnTimeoutMinutes: 0.02, turnMaxMinutes: 0.05, developer: HANDOFF, tester: CPU_TESTER });
  expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
  const pid = await agentPid(w, "tester");
  await waitFor("the hard-limit block", () => stateOf(w).reason === "tester turn still active after 0.05 minutes");
  return { w, pid };
}

describe("AC-4: a turn still active at the hard limit asks the user", { timeout: 30_000 }, () => {
  it("blocks without stopping the agent and continues once the turn's result appears", async () => {
    const { w, pid } = await atHardLimit();
    const reason = "tester turn still active after 0.05 minutes";
    const workerPid = stateOf(w).pids.workers.tester as number;
    expect(statusJson(w)).toMatchObject({ status: "blocked", reason, next_step: "gdt extend 12 or gdt retry 12" });
    expect(gdtWorld(w, "wait", "12")).toMatchObject({ code: 0, stdout: `blocked: ${reason}. Next: gdt extend 12 or gdt retry 12\n` });
    const notifications = lines(join(w.bin, "notifications"));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain(reason);

    // The agent and worker keep running while the workflow waits for the user.
    await sleep(1000);
    expect(alive(pid)).toBe(true);
    expect(alive(workerPid)).toBe(true);
    expect(stateOf(w).reason).toBe(reason);

    // The agent finishes: it posts a valid test record and exits 0, and the workflow moves on.
    writeFileSync(join(w.root, "scripts/finish"), "");
    await waitFor("the reviewer dispatch", () => supervisorLog(w).includes("dispatched reviewer"));
    expect(stateOf(w).role).toBe("reviewer");
  });
});

describe("AC-5: gdt extend grants more time to a turn at the hard limit", { timeout: 30_000 }, () => {
  it("moves the hard limit, returns to running and blocks again at the new hard limit", async () => {
    const { w, pid } = await atHardLimit();
    const before = Date.now();
    const extended = gdtWorld(w, "extend", "12");
    const after = Date.now();
    expect(extended.code).toBe(0);
    expect(extended.stdout).toMatch(/^Extended the tester turn of #12; new hard limit \S+Z\. Next: wait\n$/);

    const out = statusJson(w);
    expect(out.status).toBe("running");
    const hardLimit = Date.parse(out.turn_hard_limit as string);
    expect(hardLimit).toBeGreaterThanOrEqual(before + 3000);
    expect(hardLimit).toBeLessThanOrEqual(after + 3000);
    expect(extended.stdout).toContain(out.turn_hard_limit as string);

    // In any other state the command fails with the status and the next step and changes nothing.
    const again = gdtWorld(w, "extend", "12");
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("running");
    expect(again.stderr).toContain("Next: wait");
    expect(statusJson(w).turn_hard_limit).toBe(out.turn_hard_limit);

    // AC-1 to AC-4 apply again: the still-active turn runs until its new hard limit.
    await waitFor("the supervisor to apply the extension", () => stateOf(w).status === "running");
    await waitFor("the second hard-limit block", () => stateOf(w).status === "blocked", 10_000);
    expect(Date.now()).toBeGreaterThanOrEqual(hardLimit);
    expect(stateOf(w).reason).toMatch(/^tester turn still active after [\d.]+ minutes$/);
    expect(alive(pid)).toBe(true);
  });

  it("fails without a workflow", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    expect(gdt(["extend", "7"], root, fakePath())).toMatchObject({ code: 1, stderr: "No workflow for #7. Next: gdt start 7\n" });
  });
});

describe("AC-6: an exited agent is reported without waiting for the deadline", { timeout: 30_000 }, () => {
  it("blocks when the worker and the agent were killed, and gdt retry runs the turn again", async () => {
    const w = world({ pr: true, developer: HANDOFF, tester: agent("echo run >> scripts/tester-runs\n/bin/sleep 600\n") });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    const pid = await agentPid(w, "tester");
    const workerPid = stateOf(w).pids.workers.tester as number;

    // SIGKILL leaves the worker no chance to write a result for the killed agent.
    process.kill(workerPid, "SIGKILL");
    process.kill(-pid, "SIGKILL");
    const killedAt = Date.now();
    const reason = "tester agent exited without a result";
    await waitFor("the exited-agent block", () => stateOf(w).reason === reason);
    // Default limits: a 60-minute deadline, so only the exit check can have fired.
    expect(Date.now() - killedAt).toBeLessThan(5000);
    expect(statusJson(w)).toMatchObject({ status: "blocked", reason, next_step: "gdt retry 12" });
    expect(lines(join(w.bin, "notifications")).some((line) => line.includes(reason))).toBe(true);

    expect(gdtWorld(w, "retry", "12")).toMatchObject({ code: 0, stdout: "Retry prepared for #12. Next: gdt start 12\n" });
    expect(gdtWorld(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the second tester turn", () => stateOf(w).status === "running" && stateOf(w).role === "tester");
    expect(stateOf(w).round).toBe(0);
    await waitFor("the second tester invocation", () => lines(join(w.root, "scripts/tester-runs")).length === 2);
  });
});

describe("AC-7: the new limits are configurable and validated", () => {
  const withKeys = (keys: string) => EXAMPLE_CONFIG.replace('terminal = "herdr"', `terminal = "herdr"\n${keys}`);
  const doctor = (config: string) => {
    const result = gdt(["doctor", "--json"], tempRepo({ ".gdt/config.toml": config }), fakePath());
    return { code: result.code, report: JSON.parse(result.stdout) as { config: { workflow: Record<string, number> }; findings: { level: string; message: string }[] } };
  };

  it("defaults to 10 and 120 without the keys", () => {
    const { code, report } = doctor(EXAMPLE_CONFIG);
    expect(code).toBe(0);
    expect(report.config.workflow).toMatchObject({ turn_idle_minutes: 10, turn_max_minutes: 120 });
  });

  it("accepts positive numbers", () => {
    const { code, report } = doctor(withKeys("turn_idle_minutes = 2.5\nturn_max_minutes = 90"));
    expect(code).toBe(0);
    expect(report.config.workflow).toMatchObject({ turn_idle_minutes: 2.5, turn_max_minutes: 90 });
  });

  it.each(["turn_idle_minutes", "turn_max_minutes"])("rejects zero, negative and non-number values of %s", (key) => {
    for (const value of ["0", "-3", '"ten"']) {
      const { code, report } = doctor(withKeys(`${key} = ${value}`));
      expect(code).toBe(1);
      expect(report.findings.some((f) => f.level === "error" && f.message.includes(`workflow.${key}`))).toBe(true);
    }
  });

  it("rejects a turn_max_minutes below turn_timeout_minutes", () => {
    const { code, report } = doctor(withKeys("turn_timeout_minutes = 60\nturn_max_minutes = 30"));
    expect(code).toBe(1);
    expect(report.findings.some((f) => f.level === "error" && f.message.includes("workflow.turn_max_minutes"))).toBe(true);
  });
});

describe("AC-8: gdt status --json shows last activity and hard limit", () => {
  const inflight = {
    key: "tester.r0.no-pr.abc",
    role: "tester" as const,
    round: 0,
    dispatched_at: "2026-09-29T10:00:00.000Z",
    after_comment_id: 0,
    checks: 0,
    missing: false,
  };

  function stateWith(over: Partial<State>): string {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    writeState(paths(root, 10, GIT_ENV), {
      version: 1,
      issue: 10,
      workflow_id: "a1b2c3",
      status: "running",
      reason: "",
      role: "tester",
      round: 0,
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

  const status = (root: string) => JSON.parse(gdt(["status", "10", "--json"], root, fakePath()).stdout) as Record<string, unknown>;

  it("reports dispatched_at and dispatched_at + 120 minutes before any activity", () => {
    expect(status(stateWith({ inflight }))).toMatchObject({
      turn_started_at: "2026-09-29T10:00:00.000Z",
      turn_deadline: "2026-09-29T11:00:00.000Z",
      turn_last_activity: "2026-09-29T10:00:00.000Z",
      turn_hard_limit: "2026-09-29T12:00:00.000Z",
    });
  });

  it("reports the recorded last activity and an extended hard limit", () => {
    const root = stateWith({ inflight: { ...inflight, last_activity: "2026-09-29T10:42:00.000Z", hard_limit: "2026-09-29T14:05:00.000Z" } });
    expect(status(root)).toMatchObject({ turn_last_activity: "2026-09-29T10:42:00.000Z", turn_hard_limit: "2026-09-29T14:05:00.000Z" });
  });

  it("reports null for both without an in-flight turn", () => {
    expect(status(stateWith({ status: "blocked", reason: "developer reported blocked" }))).toMatchObject({
      turn_last_activity: null,
      turn_hard_limit: null,
    });
  });

  it("reports null for both without a workflow", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    expect(status(root)).toMatchObject({ turn_last_activity: null, turn_hard_limit: null });
  });
});

describe("activity sample helpers", () => {
  it("parses the ps CPU time of Linux and macOS", () => {
    expect(parseCpuTime("0:01.50")).toBe(1.5);
    expect(parseCpuTime("00:01:02")).toBe(62);
    expect(parseCpuTime("1:02:03.00")).toBe(3723);
    expect(parseCpuTime("2-00:00:01")).toBe(172_801);
  });

  it("fires the CPU signal only for at least one more second since the last recorded activity", () => {
    const sample = { cpu: 5, processes: 1, tree: "t", log: 10, opencode: null };
    const baseline = { cpu: 4.5, tree: "t", log: 10, opencode: null };
    expect(signals(sample, baseline)).toEqual({ cpu: false, tree: false, log: false, opencode: false });
    // Without activity the CPU baseline stays, so slow use still adds up to a signal.
    const next = nextBaseline(sample, baseline, false);
    expect(next.cpu).toBe(4.5);
    expect(signals({ ...sample, cpu: 5.6 }, next).cpu).toBe(true);
  });
});
