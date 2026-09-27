import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { alive } from "../src/state.js";
import { EXAMPLE_CONFIG, fakePath, gdt as cliGdt, tempRepo } from "./helpers.js";
import {
  CLI,
  config,
  gdt,
  herdrAgentStatus,
  herdrCalls,
  herdrLayout,
  herdrPaneIds,
  herdrPanes,
  herdrTitle,
  herdrTitles,
  herdrWorkspaces,
  lines,
  stateOf,
  stopWorlds,
  supervisorLog,
  waitFor,
  world,
} from "./world.js";

afterEach(stopWorlds);

const ROLE_NAMES = ["developer", "tester", "reviewer"] as const;

describe("AC-1: workflow.supervisor_pane is a boolean that defaults to false", () => {
  it("defaults to false when the key is absent", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    const result = cliGdt(["doctor", "--json"], root, fakePath());
    const report = JSON.parse(result.stdout) as { config: { workflow: { supervisor_pane: boolean } } };
    expect(report.config.workflow.supervisor_pane).toBe(false);
    expect(result.code).toBe(0);
  });

  it("reports a non-boolean value as an error that names the key", () => {
    const bad = EXAMPLE_CONFIG.replace('terminal = "herdr"', 'terminal = "herdr"\nsupervisor_pane = "yes"');
    const root = tempRepo({ ".gdt/config.toml": bad });
    const result = cliGdt(["doctor", "--json"], root, fakePath());
    const report = JSON.parse(result.stdout) as { findings: { check: string; level: string; message: string; fix: string }[] };
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        check: "config",
        level: "error",
        message: 'workflow.supervisor_pane: expected boolean, got "yes"',
      }),
    );
    expect(result.code).toBe(1);
  });

  it("accepts supervisor_pane = true", () => {
    const config = EXAMPLE_CONFIG.replace('terminal = "herdr"', 'terminal = "herdr"\nsupervisor_pane = true');
    const root = tempRepo({ ".gdt/config.toml": config });
    const result = cliGdt(["doctor", "--json"], root, fakePath());
    const report = JSON.parse(result.stdout) as { config: { workflow: { supervisor_pane: boolean } } };
    expect(report.config.workflow.supervisor_pane).toBe(true);
    expect(result.code).toBe(0);
  });
});

describe("AC-2: without a supervisor pane herdr shows only the role panes", { timeout: 30_000 }, () => {
  it("creates three equal panes, left to right developer, tester, reviewer", async () => {
    const w = world({ terminal: "herdr", supervisorPane: false, developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("three panes and three workers", () => herdrPanes(w).length === 3 && Object.keys(stateOf(w).pids.workers).length === 3);

    expect(Object.values(herdrWorkspaces(w)).map((workspace) => workspace.label)).toEqual(["gdt-12"]);
    expect(Object.keys(herdrPaneIds(w)).sort()).toEqual(["developer", "reviewer", "tester"]);

    const ids = herdrPaneIds(w);
    const layout = herdrLayout(w);
    expect(layout.map((pane) => pane.pane_id)).toEqual(ROLE_NAMES.map((role) => ids[role]));
    for (const pane of layout) expect(pane.width).toBeCloseTo(1 / 3, 3);
  });
});

describe("AC-3: the supervisor runs detached and writes the supervisor log", { timeout: 30_000 }, () => {
  it("survives the calling shell and logs its dispatch lines", async () => {
    const w = world({ terminal: "herdr", supervisorPane: false, notifier: false, developer: "exit 3\n" });
    const began = Date.now();
    const result = spawnSync("/bin/sh", ["-c", `"${process.execPath}" "${CLI}" start 12`], { cwd: w.root, env: w.env, encoding: "utf8" });
    expect(Date.now() - began).toBeLessThan(5000);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Supervisor started for #12; logs: .git/gdt/issue-12/logs");

    const pid = stateOf(w).pids.supervisor;
    expect(pid).not.toBeNull();
    expect(alive(pid)).toBe(true);
    await waitFor("the supervisor to leave the calling shell", () => {
      const ppid = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
      return Number(ppid) !== process.pid;
    });

    await waitFor("failed", () => stateOf(w).status === "failed");
    const log = supervisorLog(w);
    expect(log).toContain(`supervisor ${pid} for #12, workflow`);
    expect(log).toContain("dispatched developer");
    expect(gdt(w, "status", "12").stdout).toBe("developer turn failed (exit code 3). Next: gdt retry 12\n");
    expect(gdt(w, "wait", "12").stdout).toBe("developer turn failed (exit code 3). Next: gdt retry 12\n");
    expect(gdt(w, "retry", "12")).toMatchObject({ code: 0, stdout: "Retry prepared for #12. Next: gdt start 12\n" });
    expect(gdt(w, "status", "12").stdout).toBe("stopped. Next: gdt start 12\n");
  });
});

describe("AC-4: a leftover supervisor pane is closed", { timeout: 30_000 }, () => {
  it("closes the pane, keeps the three role panes and drops the panes.json entry", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("four panes", () => herdrPanes(w).length === 4);
    const before = herdrPaneIds(w);
    const supervisorPane = before.supervisor;
    expect(supervisorPane).toBeDefined();
    expect(gdt(w, "stop", "12").code).toBe(0);

    // A migration: the workspace keeps its supervisor pane, the config no longer wants one.
    writeFileSync(join(w.root, ".gdt/config.toml"), config(5, "herdr", false));
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("three panes", () => herdrPanes(w).length === 3);

    expect(herdrCalls(w)).toContainEqual(["pane", "close", supervisorPane]);
    expect(herdrPaneIds(w)).not.toHaveProperty("supervisor");
    expect(herdrPaneIds(w)).toEqual({ developer: before.developer, tester: before.tester, reviewer: before.reviewer });
  });
});

describe("AC-5: supervisor_pane = true keeps the four-pane workspace", { timeout: 30_000 }, () => {
  it("lays out supervisor, developer, tester and reviewer at a quarter each and reports its state", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("four panes", () => herdrPanes(w).length === 4);

    const ids = herdrPaneIds(w);
    expect(Object.keys(ids).sort()).toEqual(["developer", "reviewer", "supervisor", "tester"]);
    const layout = herdrLayout(w);
    expect(layout.map((pane) => pane.pane_id)).toEqual(["supervisor", ...ROLE_NAMES].map((name) => ids[name]));
    for (const pane of layout) expect(pane.width).toBeCloseTo(0.25, 3);

    expect(herdrTitles(w).map((title) => title.label)).toContain("supervisor · starting");
    await waitFor("a supervisor agent state", () => herdrAgentStatus(w, "supervisor") !== "");
    expect(herdrCalls(w)).toContainEqual(
      expect.arrayContaining(["pane", "report-agent", "--agent", "gdt"]),
    );
  });
});

describe("AC-6: no supervisor state is reported without a supervisor pane", { timeout: 30_000 }, () => {
  it("never renames or reports state for a supervisor, while role panes keep theirs", async () => {
    const w = world({ terminal: "herdr", supervisorPane: false, notifier: false, developer: "exit 0\n", handoffChecks: 5 });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("blocked", () => stateOf(w).status === "blocked");
    expect(herdrTitle(w, "developer")).toBe("developer · fake · DONE");

    expect(gdt(w, "stop", "12").code).toBe(0);
    for (const role of ROLE_NAMES) expect(herdrTitle(w, role)).toBe(`${role} · fake · STOPPED`);

    const calls = herdrCalls(w);
    const reportsGdt = (args: string[]) =>
      args[0] === "pane" && args[1] === "report-agent" && args[args.indexOf("--agent") + 1] === "gdt";
    expect(calls.some(reportsGdt)).toBe(false);
    expect(herdrTitles(w).map((title) => title.label).some((label) => label.startsWith("supervisor"))).toBe(false);
    expect(supervisorLog(w)).not.toContain("warning");
  });
});

describe("AC-7: the notification fallback writes to the supervisor log", { timeout: 30_000 }, () => {
  it("writes the notification line when no notifier is on PATH", async () => {
    const w = world({ terminal: "herdr", supervisorPane: false, notifier: false, developer: "exit 3\n" });
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("failed", () => stateOf(w).status === "failed");
    expect(supervisorLog(w)).toContain("notification: gdt #12: failed: developer turn failed (exit code 3)");
  });
});

describe("AC-8: headless mode is unchanged", { timeout: 30_000 }, () => {
  it.each([true, false])("writes the supervisor and role logs with supervisor_pane = %s", async (supervisorPane) => {
    const w = world({ terminal: "headless", supervisorPane, notifier: false, developer: "exit 0\n", handoffChecks: 5 });
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("blocked", () => stateOf(w).status === "blocked");
    expect(supervisorLog(w)).not.toBe("");
    for (const name of ["supervisor", ...ROLE_NAMES]) {
      expect(lines(join(w.root, ".git/gdt/issue-12/logs", `${name}.log`)).length).toBeGreaterThan(0);
    }
    expect(herdrCalls(w)).toEqual([]);
  });
});
