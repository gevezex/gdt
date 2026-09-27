import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXAMPLE_CONFIG, fakePath, gdt as cliGdt, tempRepo } from "./helpers.js";
import {
  config,
  gdt,
  herdrCalls,
  herdrDisplayAgent,
  herdrPaneIds,
  herdrPanes,
  herdrTabOf,
  herdrTabs,
  herdrTitle,
  herdrTitles,
  stateOf,
  stopWorlds,
  waitFor,
  world,
} from "./world.js";

afterEach(stopWorlds);

const ROLE_NAMES = ["developer", "tester", "reviewer"] as const;

interface DoctorResult {
  config: { valid: boolean; workflow: { herdr_layout: string } };
  findings: { check: string; level: string; message: string; fix: string }[];
}

/** `gdt doctor --json` against a config text. */
function doctorJson(configText: string): { code: number | null; report: DoctorResult } {
  const root = tempRepo({ ".gdt/config.toml": configText });
  const result = cliGdt(["doctor", "--json"], root, fakePath());
  return { code: result.code, report: JSON.parse(result.stdout) as DoctorResult };
}

describe("AC-1: the agents overview shows the role label", { timeout: 30_000 }, () => {
  it("sets <role> · <agent> per pane and gdt · supervisor, leaving report-agent unchanged", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "/bin/sleep 60\n", roleAgents: { tester: "codex" } });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor(
      "every display label",
      () =>
        herdrDisplayAgent(w, "supervisor") === "gdt · supervisor" &&
        herdrDisplayAgent(w, "developer") === "developer · fake" &&
        herdrDisplayAgent(w, "tester") === "tester · codex" &&
        herdrDisplayAgent(w, "reviewer") === "reviewer · fake",
    );

    const ids = herdrPaneIds(w);
    // herdr 0.9.1 wants the pane id before the options; see the deviation in the pull request.
    expect(herdrCalls(w)).toContainEqual(["pane", "report-metadata", ids.tester, "--source", "gdt", "--display-agent", "tester · codex"]);
    expect(herdrCalls(w)).toContainEqual(["pane", "report-metadata", ids.supervisor, "--source", "gdt", "--display-agent", "gdt · supervisor"]);
    expect(herdrCalls(w)).toContainEqual(["pane", "report-agent", "--source", "gdt", "--agent", "codex", "--state", "idle", ids.tester]);
  });

  it("updates the label after gdt set-agent changes the role's agent", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the initial developer label", () => herdrDisplayAgent(w, "developer") === "developer · fake");
    const tester = herdrPaneIds(w).tester;

    expect(gdt(w, "set-agent", "12", "tester", "opencode/some-model").code).toBe(0);
    await waitFor("the new tester label", () => herdrDisplayAgent(w, "tester") === "tester · opencode");
    expect(herdrCalls(w)).toContainEqual(["pane", "report-metadata", tester, "--source", "gdt", "--display-agent", "tester · opencode"]);
  });
});

describe("AC-2: workflow.herdr_layout is validated and defaults to split", () => {
  it("defaults to split when the key is absent", () => {
    const { code, report } = doctorJson(EXAMPLE_CONFIG);
    expect(report.config.workflow.herdr_layout).toBe("split");
    expect(code).toBe(0);
  });

  it("accepts tabs", () => {
    const { code, report } = doctorJson(EXAMPLE_CONFIG.replace('terminal = "herdr"', 'terminal = "herdr"\nherdr_layout = "tabs"'));
    expect(report.config.workflow.herdr_layout).toBe("tabs");
    expect(code).toBe(0);
  });

  it("reports any other value as an error naming the key and both allowed values", () => {
    const bad = EXAMPLE_CONFIG.replace('terminal = "herdr"', 'terminal = "herdr"\nherdr_layout = "grid"');
    const { code, report } = doctorJson(bad);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        check: "config",
        level: "error",
        message: 'workflow.herdr_layout: "grid" is not one of split, tabs',
      }),
    );
    expect(report.config.valid).toBe(false);
    expect(code).toBe(1);
  });

  it("has no effect with workflow.terminal = headless", async () => {
    const w = world({ terminal: "headless", herdrLayout: "tabs", developer: "exit 0\n", handoffChecks: 5 });
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("blocked", () => stateOf(w).status === "blocked");
    expect(herdrCalls(w)).toEqual([]);
  });
});

describe("AC-3: with tabs, a new workspace gets one tab per managed pane", { timeout: 30_000 }, () => {
  it("creates one labelled tab per role, in order, without splitting a pane", async () => {
    const w = world({ terminal: "herdr", supervisorPane: false, herdrLayout: "tabs", developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("three panes and titles", () => herdrPanes(w).length === 3 && herdrTitle(w, "developer") !== "");

    expect(herdrTabs(w).map((tab) => tab.label)).toEqual(["developer", "tester", "reviewer"]);
    expect(herdrTabs(w).map((tab) => tab.pane_count)).toEqual([1, 1, 1]);
    expect(Object.keys(herdrPaneIds(w)).sort()).toEqual(["developer", "reviewer", "tester"]);
    for (const role of ROLE_NAMES) expect(herdrTabOf(w, role)).toBe(role);
    for (const role of ROLE_NAMES) expect(herdrTitles(w).map((title) => title.label)).toContain(`${role} · fake · WAITING`);

    const calls = herdrCalls(w);
    expect(calls.some((args) => args[0] === "pane" && args[1] === "split")).toBe(false);
    // No tab is focused: every tab creation or pane move is explicitly unfocused.
    for (const args of calls) {
      const createsTab = args[0] === "tab" && args[1] === "create";
      if (createsTab || (args[0] === "pane" && args[1] === "move")) expect(args).toContain("--no-focus");
    }
  });

  it("puts the supervisor first when supervisor_pane = true", async () => {
    const w = world({ terminal: "herdr", supervisorPane: true, herdrLayout: "tabs", developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("four panes in four tabs", () => herdrPanes(w).length === 4 && herdrTabs(w).length === 4);
    expect(herdrTabs(w).map((tab) => tab.label)).toEqual(["supervisor", "developer", "tester", "reviewer"]);
    for (const tab of herdrTabs(w)) expect(tab.pane_count).toBe(1);
  });
});

describe("AC-4: with split, the layout is unchanged", { timeout: 30_000 }, () => {
  it("splits one tab and adds no tab or pane-move calls", async () => {
    const w = world({ terminal: "herdr", supervisorPane: false, developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("three panes and the developer label", () => herdrPanes(w).length === 3 && herdrDisplayAgent(w, "developer") === "developer · fake");

    expect(herdrTabs(w)).toHaveLength(1);
    const calls = herdrCalls(w);
    expect(calls.filter((args) => args[0] === "pane" && args[1] === "split")).toHaveLength(2);
    expect(calls.some((args) => args[0] === "tab")).toBe(false);
    expect(calls.some((args) => args[0] === "pane" && args[1] === "move")).toBe(false);
  });
});

describe("AC-5: changing the layout rearranges existing panes on the next start", { timeout: 60_000 }, () => {
  it("moves each pane into a labelled tab when switching split -> tabs", async () => {
    const w = world({ terminal: "herdr", supervisorPane: false, developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("three panes", () => herdrPanes(w).length === 3);
    const before = herdrPaneIds(w);
    expect(gdt(w, "stop", "12").code).toBe(0);
    const callsBefore = herdrCalls(w).length;

    writeFileSync(join(w.root, ".gdt/config.toml"), config(5, "herdr", false, "tabs"));
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("three labelled tabs", () => herdrTabs(w).length === 3 && herdrTabs(w).every((tab) => tab.pane_count === 1));

    expect(herdrPaneIds(w)).toEqual(before);
    expect(herdrTabs(w).map((tab) => tab.label)).toEqual(["developer", "tester", "reviewer"]);
    const moved = herdrCalls(w).slice(callsBefore);
    expect(moved).toContainEqual(["pane", "move", before.developer, "--new-tab", "--label", "developer", "--no-focus"]);
    expect(moved.some((args) => args[0] === "pane" && args[1] === "split")).toBe(false);
    for (const pane of Object.values(before)) expect(moved).not.toContainEqual(["pane", "close", pane]);
  });

  it("moves every pane into one tab when switching tabs -> split", async () => {
    const w = world({ terminal: "herdr", supervisorPane: false, herdrLayout: "tabs", developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("three tabs", () => herdrTabs(w).length === 3);
    const before = herdrPaneIds(w);
    expect(gdt(w, "stop", "12").code).toBe(0);
    const callsBefore = herdrCalls(w).length;

    writeFileSync(join(w.root, ".gdt/config.toml"), config(5, "herdr", false, "split"));
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("one tab", () => herdrTabs(w).length === 1 && herdrPanes(w).length === 3);

    expect(herdrPaneIds(w)).toEqual(before);
    expect(new Set(herdrPanes(w).map((pane) => pane.tab_id)).size).toBe(1);
    const moved = herdrCalls(w).slice(callsBefore);
    expect(moved.some((args) => args[0] === "pane" && args[1] === "move")).toBe(true);
    for (const pane of Object.values(before)) expect(moved).not.toContainEqual(["pane", "close", pane]);
  });
});

describe("AC-6: documentation names the setting and the role label", () => {
  it("the README configuration table lists workflow.herdr_layout with default split and both values", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toMatch(/\| `workflow\.herdr_layout` \| `split` \|/);
    expect(readme).toContain('`"split"`');
    expect(readme).toContain('`"tabs"`');
  });

  it("design.md shows the key in the example config and describes both layouts and the role label", () => {
    const design = readFileSync("docs/design.md", "utf8");
    expect(design).toContain('herdr_layout = "split"');
    const backends = design.slice(design.indexOf("### 9.6"));
    expect(backends).toContain("herdr_layout");
    expect(backends).toContain("`split`");
    expect(backends).toContain("`tabs`");
    expect(backends).toContain("`<role> · <agent>`");
    expect(backends).toContain("`gdt · supervisor`");
  });

  it("docs/agents.md mentions the role label in the herdr section", () => {
    const docs = readFileSync("docs/agents.md", "utf8");
    expect(docs).toContain("`<role> · <agent>`");
    expect(docs).toContain("`gdt · supervisor`");
    expect(docs).toContain("herdr_layout");
  });
});
