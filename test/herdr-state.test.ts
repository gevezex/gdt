import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STATUSES, type Status } from "../src/state.js";
import { supervisorAgentState } from "../src/supervisor.js";
import { gdt, herdrAgentStatus, herdrCalls, herdrPaneIds, herdrPaneLog, stateOf, stopWorlds, waitFor, world, type World } from "./world.js";

afterEach(stopWorlds);

const CLEAR = "\x1b[2J";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** The last non-empty line of a pane's raw output. */
function lastLine(text: string): string {
  return text.split("\n").filter((line) => line !== "").at(-1) ?? "";
}

/** The pane id the world's panes.json holds for a pane name. */
function paneId(w: World, name: string): string {
  const id = herdrPaneIds(w)[name];
  if (id === undefined) throw new Error(`no pane named ${name}`);
  return id;
}

/** Runs the world's fake `herdr pane read`, as the AC examples do. */
function herdrRead(w: World, paneId: string, lines: number): string {
  const result = spawnSync(join(w.bin, "herdr"), ["pane", "read", paneId, "--lines", String(lines)], {
    env: { ...process.env, PATH: w.env.PATH ?? "", HOME: w.env.HOME ?? "" },
    encoding: "utf8",
  });
  return result.stdout;
}

describe("AC-1: a waiting role pane is cleared but keeps its scrollback", { timeout: 30_000 }, () => {
  it("shows the waiting line after a turn and still reads the turn's output", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "printf 'developer-turn-output\\n'; exit 0\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the developer waiting line", () => herdrPaneLog(w, "developer").includes(`${DIM}developer waiting · last turn DONE`));

    const log = herdrPaneLog(w, "developer");
    expect(log).toContain("developer-turn-output");
    // The clear comes after the turn's output, so the visible screen shows only the waiting line.
    expect(log.lastIndexOf(CLEAR)).toBeGreaterThan(log.indexOf("developer-turn-output"));
    expect(lastLine(log)).toMatch(/developer waiting · last turn DONE \d{2}:\d{2}/);

    // The scrollback still contains the turn's last line after the clear.
    const read = herdrRead(w, paneId(w, "developer"), 200);
    expect(read).toContain("developer-turn-output");
    expect(lastLine(read)).toMatch(/developer waiting · last turn DONE \d{2}:\d{2}/);
  });
});

describe("AC-2: the waiting line names the last result", { timeout: 30_000 }, () => {
  it("is dim, names the role, and says no turn ran yet", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "printf 'developer-turn-output\\n'; exit 0\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the tester waiting line", () => herdrPaneLog(w, "tester").includes("tester waiting · no turn yet"));
    expect(herdrPaneLog(w, "tester")).toContain(`${DIM}tester waiting · no turn yet${RESET}`);
  });

  it("names the last turn state and its time", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "printf 'developer-turn-output\\n'; exit 0\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the developer waiting line", () => herdrPaneLog(w, "developer").includes(`${DIM}developer waiting · last turn DONE `));

    const log = herdrPaneLog(w, "developer");
    const marker = `${DIM}developer waiting · last turn DONE `;
    const at = log.indexOf(marker);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(log.slice(at + marker.length, at + marker.length + 5)).toMatch(/^\d{2}:\d{2}$/);
    expect(log.slice(at + marker.length + 5, at + marker.length + 5 + RESET.length)).toBe(RESET);
  });

  it("names the last turn again after a stop and start", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "printf 'developer-turn-output\\n'; exit 0\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the first waiting line", () => herdrPaneLog(w, "developer").includes(`${DIM}developer waiting · last turn DONE`));

    expect(gdt(w, "stop", "12").code).toBe(0);
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the restarted waiting line", () => (herdrPaneLog(w, "developer").match(/developer waiting · last turn DONE/g) ?? []).length >= 2);
    expect(lastLine(herdrPaneLog(w, "developer"))).toContain("developer waiting · last turn DONE");
  });
});

describe("AC-3: a starting turn clears the pane and uses normal colours", { timeout: 30_000 }, () => {
  it("clears and resets colours before the agent's output", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "printf 'developer-turn-output\\n'; exit 0\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the developer waiting line", () => herdrPaneLog(w, "developer").includes(`${DIM}developer waiting · last turn DONE`));

    const log = herdrPaneLog(w, "developer");
    const startOfTurn = log.indexOf(`${CLEAR}${RESET}`);
    expect(startOfTurn).toBeGreaterThan(log.indexOf(`${DIM}developer waiting · no turn yet${RESET}`));
    expect(startOfTurn).toBeLessThan(log.indexOf("developer-turn-output"));
  });
});

describe("AC-4: role panes report their state to herdr", { timeout: 30_000 }, () => {
  it("reports working and idle with source gdt and the agent label", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "exit 0\n", handoffChecks: 5 });
    expect(gdt(w, "start", "12").code).toBe(0);

    const pane = paneId(w, "developer");
    const report = (state: string) => ["pane", "report-agent", "--source", "gdt", "--agent", "fake", "--state", state, pane];
    const reported = (state: string) => herdrCalls(w).some((args) => JSON.stringify(args) === JSON.stringify(report(state)));
    // Wait for RUNNING first: the startup WAITING report is also `idle`.
    await waitFor("the developer RUNNING report", () => reported("working"));
    await waitFor("the developer DONE report", () => herdrAgentStatus(w, "developer") === "idle");
    expect(herdrCalls(w)).toContainEqual(report("working"));
    expect(herdrCalls(w)).toContainEqual(report("idle"));
  });

  it("reports blocked for a failed turn", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "exit 3\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the failure", () => stateOf(w).status === "failed");

    const pane = paneId(w, "developer");
    expect(herdrCalls(w)).toContainEqual(["pane", "report-agent", "--source", "gdt", "--agent", "fake", "--state", "blocked", pane]);
    expect(herdrAgentStatus(w, "developer")).toBe("blocked");
  });
});

describe("AC-5: the supervisor pane shows when the user is needed", { timeout: 30_000 }, () => {
  it("maps every workflow status to its herdr state", () => {
    const expected: Record<Status, "idle" | "working" | "blocked"> = {
      starting: "working",
      running: "working",
      paused: "idle",
      awaiting_human: "blocked",
      waiting_for_checks: "working",
      ready_to_merge: "idle",
      blocked: "blocked",
      contract_changed: "working",
      failed: "blocked",
      stopped: "idle",
    };
    for (const status of STATUSES) expect(supervisorAgentState(status), status).toBe(expected[status]);
  });

  it("reports blocked for failed and idle for stopped, as source gdt with label gdt", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "exit 3\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the failure", () => stateOf(w).status === "failed");
    expect(herdrAgentStatus(w, "supervisor")).toBe("blocked");
    expect(herdrCalls(w)).toContainEqual(["pane", "report-agent", "--source", "gdt", "--agent", "gdt", "--state", "blocked", paneId(w, "supervisor")]);

    expect(gdt(w, "stop", "12").code).toBe(0);
    expect(herdrAgentStatus(w, "supervisor")).toBe("idle");
    expect(herdrCalls(w)).toContainEqual(["pane", "report-agent", "--source", "gdt", "--agent", "gdt", "--state", "idle", paneId(w, "supervisor")]);
  });
});

describe("AC-6: a failing report does not affect the workflow", { timeout: 30_000 }, () => {
  it("warns once and still fails the turn", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "exit 3\n", reportFail: true });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the failure", () => stateOf(w).status === "failed");

    const log = herdrPaneLog(w, "supervisor");
    expect(log.match(/warning: herdr state report failed: .*/g) ?? []).toHaveLength(1);
    expect(stateOf(w).status).toBe("failed");
  });
});

describe("AC-7: headless mode is unchanged", { timeout: 30_000 }, () => {
  it("writes no escape sequences and reports no herdr state", async () => {
    const w = world({ terminal: "headless", developer: "printf 'developer-turn-output\\n'; exit 0\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    const file = join(w.root, ".git/gdt/issue-12/logs/developer.log");
    await waitFor("the turn output", () => existsSync(file) && readFileSync(file, "utf8").includes("developer-turn-output"));

    const log = readFileSync(file, "utf8");
    expect(log).not.toContain(CLEAR);
    expect(log).not.toContain(DIM);
    expect(existsSync(join(w.bin, "herdr-calls.jsonl"))).toBe(false);
  });
});
