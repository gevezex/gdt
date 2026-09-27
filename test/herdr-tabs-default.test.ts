import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXAMPLE_CONFIG, fakePath, gdt as cliGdt, tempRepo } from "./helpers.js";
import {
  config,
  gdt,
  herdrCalls,
  herdrPaneIds,
  herdrPanes,
  herdrTabs,
  stopWorlds,
  waitFor,
  world,
} from "./world.js";

afterEach(stopWorlds);

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

function readme(): string {
  return readFileSync("README.md", "utf8");
}

/** The README's Requirements section, without the Install section that follows it, whitespace-collapsed. */
function requirementsSection(): string {
  const text = readme();
  return text.slice(text.indexOf("## Requirements"), text.indexOf("## Install")).replace(/\s+/g, " ");
}

describe("AC-1: workflow.herdr_layout defaults to tabs", { timeout: 30_000 }, () => {
  it("uses the tabs layout for a new workspace when the key is absent", async () => {
    const { code, report } = doctorJson(EXAMPLE_CONFIG);
    expect(report.config.workflow.herdr_layout).toBe("tabs");
    expect(code).toBe(0);

    const w = world({ terminal: "herdr", supervisorPane: false, developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("three panes in three tabs", () => herdrPanes(w).length === 3 && herdrTabs(w).length === 3);

    expect(herdrTabs(w).map((tab) => tab.label)).toEqual(["developer", "tester", "reviewer"]);
    for (const tab of herdrTabs(w)) expect(tab.pane_count).toBe(1);
    expect(herdrCalls(w).some((args) => args[0] === "pane" && args[1] === "split")).toBe(false);
  });

  it("still accepts split and still rejects any other value", () => {
    const split = doctorJson(EXAMPLE_CONFIG.replace('terminal = "herdr"', 'terminal = "herdr"\nherdr_layout = "split"'));
    expect(split.report.config.workflow.herdr_layout).toBe("split");
    expect(split.code).toBe(0);

    const bad = doctorJson(EXAMPLE_CONFIG.replace('terminal = "herdr"', 'terminal = "herdr"\nherdr_layout = "grid"'));
    expect(bad.report.config.valid).toBe(false);
    expect(bad.code).toBe(1);
    expect(bad.report.findings).toContainEqual(
      expect.objectContaining({
        check: "config",
        level: "error",
        message: 'workflow.herdr_layout: "grid" is not one of split, tabs',
      }),
    );
  });
});

describe("AC-2: an existing split workspace moves to tabs under the new default", { timeout: 60_000 }, () => {
  it("moves the live panes of a split workspace into one labelled tab each, keeping their ids", async () => {
    const w = world({ terminal: "herdr", supervisorPane: false, herdrLayout: "split", developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("three panes in one tab", () => herdrPanes(w).length === 3 && herdrTabs(w).length === 1);
    const before = herdrPaneIds(w);
    expect(gdt(w, "stop", "12").code).toBe(0);
    const callsBefore = herdrCalls(w).length;

    // The key is removed, so the new default (tabs) applies on the next start.
    writeFileSync(join(w.root, ".gdt/config.toml"), config(5, "herdr", false));
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("three labelled tabs", () => herdrTabs(w).length === 3 && herdrTabs(w).every((tab) => tab.pane_count === 1));

    expect(herdrPaneIds(w)).toEqual(before);
    expect(herdrTabs(w).map((tab) => tab.label)).toEqual(["developer", "tester", "reviewer"]);
    const moved = herdrCalls(w).slice(callsBefore);
    expect(moved).toContainEqual(["pane", "move", before.developer, "--new-tab", "--label", "developer", "--no-focus"]);
    expect(moved.some((args) => args[0] === "pane" && args[1] === "split")).toBe(false);
    for (const pane of Object.values(before)) expect(moved).not.toContainEqual(["pane", "close", pane]);
  });
});

describe("AC-3: gdt's own repository config uses the terminal defaults", () => {
  it("has no terminal or herdr_layout key and keeps the other keys", () => {
    const text = readFileSync(".gdt/config.toml", "utf8");
    expect(text).not.toMatch(/^(terminal|herdr_layout)\s*=/m);
    expect(text).toContain('required_checks = ["test"]');
    expect(text).toContain("[roles.developer]");
  });
});

describe("AC-4: documentation shows herdr with tabs as the default", () => {
  it("lists herdr_layout with default tabs in the README and presents herdr as the default in the requirements", () => {
    const text = readme();
    expect(text).toMatch(/\| `workflow\.herdr_layout` \| `tabs` \|/);

    const requirements = requirementsSection();
    expect(requirements).toContain("default");
    expect(requirements).toContain('`workflow.terminal = "headless"`');
    expect(requirements).not.toContain("(optional)");
  });

  it("shows the Watching it diagram with one tab per role", () => {
    const text = readme();
    const watching = text.slice(text.indexOf("## Watching it"), text.indexOf("## Principles"));
    expect(watching).toContain("one tab per role");
  });

  it("shows tabs in the design example config and names it the default in section 9.6", () => {
    const design = readFileSync("docs/design.md", "utf8");
    expect(design).toContain('herdr_layout = "tabs"');
    const backends = design.slice(design.indexOf("### 9.6"));
    expect(backends).toContain("`tabs` (the default)");
  });

  it("names tabs as the default in docs/agents.md", () => {
    const docs = readFileSync("docs/agents.md", "utf8");
    expect(docs).toContain("`tabs` (the default)");
  });
});

describe("AC-5: the README states the agent prerequisites and that gdt does not manage agent access", () => {
  it("explains the prerequisites next to the requirements", () => {
    const requirements = requirementsSection();
    expect(requirements).toContain("### Agent prerequisites");
    expect(requirements).toContain("`.gdt/config.toml`");
    expect(requirements).toContain("`roles.<role>.model`");
    expect(requirements).toMatch(/install the agent CLI/i);
    expect(requirements).toMatch(/log in or configure its API key or subscription/i);
    expect(requirements).toMatch(/run it once successfully/i);
    expect(requirements).toContain("its own login, tokens and credits");
    expect(requirements).toContain("stores no credentials");
    expect(requirements).toContain("does not log in");
    expect(requirements).toContain("token use or costs");
    expect(requirements).toContain("`gdt doctor` only checks that the CLI is on `PATH`");
  });
});
