import { afterEach, describe, expect, it } from "vitest";
import { alive, logTimestamp } from "../src/state.js";
import { sha256 } from "../src/supervisor.js";
import { EXAMPLE_CONFIG, fakePath, gdt as cliGdt, tempRepo } from "./helpers.js";
import {
  BODY,
  editGithub,
  gdt,
  HEAD,
  herdrCalls,
  herdrLayout,
  herdrPaneIds,
  herdrPaneLog,
  herdrPanes,
  herdrTitle,
  herdrTitles,
  herdrWorkspaces,
  stateOf,
  stopWorlds,
  waitFor,
  world,
} from "./world.js";

afterEach(stopWorlds);

const ROLES = ["supervisor", "developer", "tester", "reviewer"] as const;

/** The last non-empty line of a pane's output. */
function lastLine(text: string): string {
  return text.split("\n").filter((line) => line !== "").at(-1) ?? "";
}

/** An agent comment body carrying one protocol record. */
function record(kind: string, data: Record<string, unknown>): string {
  return `[gdt-${kind}:v1]\n${JSON.stringify(data)}\n[/gdt-${kind}:v1]\n`;
}

describe("AC-1: start creates the workspace with four panes", { timeout: 30_000 }, () => {
  it("creates gdt-12 with one pane per role, each running its gdt process", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("four panes and three workers", () => herdrPanes(w).length === 4 && Object.keys(stateOf(w).pids.workers).length === 3);

    expect(Object.values(herdrWorkspaces(w)).map((workspace) => workspace.label)).toEqual(["gdt-12"]);
    expect(Object.keys(herdrPaneIds(w)).sort()).toEqual(["developer", "reviewer", "supervisor", "tester"]);

    const state = stateOf(w);
    expect(alive(state.pids.supervisor)).toBe(true);
    for (const role of ["developer", "tester", "reviewer"] as const) expect(alive(state.pids.workers[role])).toBe(true);

    // The developer pane starts WAITING (it may already be RUNNING by the time we look).
    const pane = herdrPaneIds(w).developer;
    expect(herdrTitles(w).filter((title) => title.pane_id === pane).map((title) => title.label)).toContain("developer · fake · WAITING");
  });
});

describe("panes run left to right in role order with equal widths", { timeout: 30_000 }, () => {
  it("lays out supervisor, developer, tester and reviewer at a quarter each", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, herdrLayout: "split", developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("four panes", () => herdrPanes(w).length === 4);

    const ids = herdrPaneIds(w);
    const layout = herdrLayout(w);
    expect(layout.map((pane) => pane.pane_id)).toEqual(ROLES.map((role) => ids[role]));
    for (const pane of layout) expect(pane.width).toBeCloseTo(0.25, 3);
  });
});

describe("pane output uses a short local timestamp", { timeout: 30_000 }, () => {
  it("prefixes supervisor and worker lines with YYYY-MM-DD hh:mm:ss", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("output in every pane", () => ROLES.every((role) => herdrPaneLog(w, role).trim() !== ""));
    for (const role of ROLES) {
      const first = herdrPaneLog(w, role).split("\n")[0] ?? "";
      expect(first).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S/);
    }
  });

  it("formats a date in local time", () => {
    const date = new Date(2026, 8, 7, 5, 4, 3, 999);
    expect(logTimestamp(date)).toBe("2026-09-07 05:04:03");
  });
});

describe("AC-2: start works from outside herdr", { timeout: 30_000 }, () => {
  it("returns and prints the attach command for gdt-12", () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "/bin/sleep 60\n" });
    const result = gdt(w, "start", "12");
    expect(result.code).toBe(0);
    const workspace = Object.values(herdrWorkspaces(w)).find((candidate) => candidate.label === "gdt-12");
    expect(workspace).toBeDefined();
    expect(result.stdout).toContain(`Attach: herdr workspace focus ${workspace?.workspace_id} && herdr (workspace gdt-12)\n`);
  });
});

describe("AC-3: missing herdr is reported with an alternative", () => {
  it("start exits 1 and doctor reports an error, both with the fix", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    const path = fakePath({ herdr: false });

    const start = cliGdt(["start", "12"], root, path);
    expect(start.code).toBe(1);
    expect(start.stderr).toBe('herdr not found on PATH; install herdr or set workflow.terminal = "headless"\n');

    const doctor = cliGdt(["doctor", "--json"], root, path);
    const report = JSON.parse(doctor.stdout) as { findings: { check: string; level: string; message: string; fix: string }[] };
    expect(report.findings).toContainEqual({
      check: "herdr",
      level: "error",
      message: "herdr: not found on PATH",
      fix: 'Install or update herdr (https://herdr.dev), or set workflow.terminal = "headless"',
    });
    expect(doctor.code).toBe(1);
  });

  it("reports a herdr older than the minimum supported version", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    const path = fakePath({ herdrVersion: "0.8.0" });

    const doctor = cliGdt(["doctor", "--json"], root, path);
    const report = JSON.parse(doctor.stdout) as { findings: { level: string; message: string }[] };
    expect(report.findings).toContainEqual(
      expect.objectContaining({ level: "error", message: "herdr: 0.8.0 is older than the minimum supported 0.9.1" }),
    );
    expect(doctor.code).toBe(1);
    expect(cliGdt(["start", "12"], root, path).code).toBe(1);
  });
});

describe("AC-4: a second start reuses the workspace", { timeout: 30_000 }, () => {
  it("keeps one workspace with exactly four gdt panes", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("four panes", () => herdrPanes(w).length === 4);
    const before = herdrPaneIds(w);

    expect(gdt(w, "stop", "12").code).toBe(0);
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("four panes again", () => herdrPanes(w).length === 4 && Object.keys(stateOf(w).pids.workers).length === 3);

    expect(Object.values(herdrWorkspaces(w)).map((workspace) => workspace.label)).toEqual(["gdt-12"]);
    expect(herdrPanes(w)).toHaveLength(4);
    expect(herdrPaneIds(w)).toEqual(before);
  });
});

describe("AC-5: pane titles follow the role state", { timeout: 30_000 }, () => {
  it("shows WAITING then RUNNING then DONE for a successful turn", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "exit 0\n", handoffChecks: 5 });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the DONE title", () => herdrTitle(w, "developer") === "developer · fake · DONE");

    const pane = herdrPaneIds(w).developer;
    const labels = herdrTitles(w)
      .filter((title) => title.pane_id === pane)
      .map((title) => title.label);
    expect(labels).toContain("developer · fake · WAITING");
    expect(labels).toContain("developer · fake · RUNNING");
    expect(labels.at(-1)).toBe("developer · fake · DONE");
  });

  it("shows FAILED for a failed turn", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "exit 3\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("failed", () => stateOf(w).status === "failed");
    expect(herdrTitle(w, "developer")).toBe("developer · fake · FAILED");
  });
});

describe("AC-6: stop leaves an explanatory last line", { timeout: 30_000 }, () => {
  it("ends every process, sets STOPPED titles and writes the resume line", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the developer turn", () => stateOf(w).role === "developer" && stateOf(w).inflight !== null);

    const before = stateOf(w);
    const pids = [before.pids.supervisor, ...Object.values(before.pids.workers)];
    expect(gdt(w, "stop", "12")).toMatchObject({ code: 0, stdout: "Stopped #12. Next: gdt start 12\n" });
    for (const pid of pids) expect(alive(pid)).toBe(false);

    expect(herdrTitle(w, "supervisor")).toBe("supervisor · stopped");
    for (const role of ["developer", "tester", "reviewer"] as const) expect(herdrTitle(w, role)).toBe(`${role} · fake · STOPPED`);

    for (const name of ROLES) expect(lastLine(herdrPaneLog(w, name))).toBe("gdt stopped. Resume with: gdt start 12");
  });
});

/** A world whose PR #40 already has an approved handoff, test and review for HEAD, with green checks. */
async function approvedWorld(terminal: "headless" | "herdr") {
  const w = world({ terminal, supervisorPane: terminal === "herdr", developer: "/bin/sleep 60\n", pr: true });
  const base = { repository: "gevezex/demo", issue: 12, round: 0, pr_number: 40, issue_body_sha256: sha256(BODY) };
  const acResults = [
    { ac: "AC-1", result: "passed", evidence: "fake" },
    { ac: "AC-2", result: "passed", evidence: "fake" },
  ];
  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
  await editGithub(w, (data) => {
    data.pulls = {
      "40": { head: HEAD, mergeable: "MERGEABLE", checks: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] },
    };
    data.comments["40"] = [
      {
        id: 1,
        author: "gevezex",
        created_at: at(3),
        body: record("handoff", { role: "developer", status: "ready", ...base, acceptance_criteria: ["AC-1", "AC-2"], ac_traceability: [], assumptions: [], deviations: [] }),
      },
      {
        id: 2,
        author: "gevezex",
        created_at: at(2),
        body: record("test", { role: "tester", status: "approved", ...base, acceptance_criteria: ["AC-1", "AC-2"], head: HEAD, ac_results: acResults, findings: [] }),
      },
      {
        id: 3,
        author: "gevezex",
        created_at: at(1),
        body: record("review", { role: "reviewer", status: "approved", ...base, acceptance_criteria: ["AC-1", "AC-2"], head: HEAD, ac_results: acResults, findings: [] }),
      },
    ];
  });
  return w;
}

describe("AC-7: completion is shown in every pane", { timeout: 30_000 }, () => {
  it("prints the completion line, exits every gdt process and titles the supervisor", async () => {
    const w = await approvedWorld("herdr");

    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("ready_to_merge", () => stateOf(w).status === "ready_to_merge");
    await waitFor("the supervisor title", () => herdrTitle(w, "supervisor") === "supervisor · ready_to_merge");

    const complete = "Workflow complete: #12 is ready to merge. This pane can be closed.";
    await waitFor("every pane's final line", () => ROLES.every((name) => lastLine(herdrPaneLog(w, name)) === complete));

    const state = stateOf(w);
    await waitFor("every gdt process to exit", () => [state.pids.supervisor, ...Object.values(state.pids.workers)].every((pid) => !alive(pid)));
  });
});

describe("headless mode keeps its workers after ready_to_merge", { timeout: 30_000 }, () => {
  it("leaves the supervisor and every worker running", async () => {
    const w = await approvedWorld("headless");
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("ready_to_merge", () => stateOf(w).status === "ready_to_merge");
    // Several worker polls (250 ms each) after the status change.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const state = stateOf(w);
    expect(state.status).toBe("ready_to_merge");
    for (const pid of [state.pids.supervisor, ...Object.values(state.pids.workers)]) expect(alive(pid)).toBe(true);
  });
});

describe("herdr agent-state is display only", { timeout: 30_000 }, () => {
  it("is never read by the supervisor", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "exit 0\n", handoffChecks: 5 });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the DONE title", () => herdrTitle(w, "developer") === "developer · fake · DONE");

    const calls = herdrCalls(w);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((args) => args[0] === "agent")).toBe(false);
    expect(calls.some((args) => args.includes("detection"))).toBe(false);
  });
});
