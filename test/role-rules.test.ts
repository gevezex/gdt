import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DoctorReport } from "../src/doctor.js";
import { buildPrompt, type PromptDispatch, roleFile } from "../src/prompts.js";
import { EXAMPLE_CONFIG, gdt, tempRepo } from "./helpers.js";

const CONFIG = join(".gdt", "config.toml");

const SPECS = [
  "--developer",
  "opencode/deepseek/deepseek-v4-flash",
  "--tester",
  "claude/claude-sonnet-5",
  "--reviewer",
  "codex/gpt-5.6-luna",
];

const dispatch = (over: Partial<PromptDispatch> = {}): PromptDispatch => ({
  repository: "gevezex/demo",
  issue: 12,
  round: 1,
  pr_number: 40,
  head: "b".repeat(40),
  issue_body_sha256: "a".repeat(64),
  acceptance_criteria: ["AC-1", "AC-2"],
  language: "en",
  directives: [],
  ...over,
});

const rulesPath = (root: string, role: string) => join(root, ".gdt", "roles", `${role}.md`);

describe("AC-1: a role rules file with content is appended to that role's prompt only", () => {
  it("ends the tester prompt with its rules, after Project rules, and leaves gdt's role file untouched", () => {
    const root = tempRepo({
      ".gdt/rules.md": "Global project rule.\n",
      ".gdt/roles/tester.md": "Run the e2e suite with Playwright.\n",
      ".gdt/roles/developer.md": "   \n",
      ".gdt/roles/reviewer.md": "",
    });
    const prompt = buildPrompt("tester", dispatch(), { root, extraRules: ".gdt/rules.md" });

    expect(prompt.endsWith("## Role rules\n\nRun the e2e suite with Playwright.\n")).toBe(true);
    expect(prompt.startsWith(roleFile("tester").trimEnd())).toBe(true);
    // The role rules come after the global project rules.
    expect(prompt.indexOf("## Project rules")).toBeLessThan(prompt.indexOf("## Role rules"));
  });

  it("adds no Role rules section and none of the tester text to the developer prompt", () => {
    const root = tempRepo({ ".gdt/roles/tester.md": "Run the e2e suite with Playwright.\n" });
    const prompt = buildPrompt("developer", dispatch(), { root });
    expect(prompt).not.toContain("## Role rules");
    expect(prompt).not.toContain("Run the e2e suite with Playwright.");
  });
});

describe("AC-2: a missing or empty role rules file adds nothing and is no error", () => {
  it("gives the same prompt as without the feature for a missing, zero-byte, or whitespace-only file", () => {
    const plain = buildPrompt("reviewer", dispatch(), { root: tempRepo() });
    const missingDir = buildPrompt("reviewer", dispatch(), { root: tempRepo({ "src/a.ts": "export {};\n" }) });
    const zeroBytes = buildPrompt("reviewer", dispatch(), { root: tempRepo({ ".gdt/roles/reviewer.md": "" }) });
    const whitespace = buildPrompt("reviewer", dispatch(), { root: tempRepo({ ".gdt/roles/reviewer.md": "\n  \n" }) });

    expect(missingDir).toBe(plain);
    expect(zeroBytes).toBe(plain);
    expect(whitespace).toBe(plain);
  });

  it("makes gdt doctor report nothing about role rules files", () => {
    const root = tempRepo({
      [CONFIG]: EXAMPLE_CONFIG,
      ".gdt/roles/tester.md": "Run the e2e suite with Playwright.\n",
    });
    const result = gdt(["doctor", "--json"], root);
    const report = JSON.parse(result.stdout) as DoctorReport;
    const mentioned = report.findings.filter((f) => f.message.includes(".gdt/roles") || f.fix.includes(".gdt/roles"));
    expect(mentioned).toEqual([]);
  });
});

describe("AC-3: the file is read on every turn", () => {
  it("returns a different Role rules section after the file changes between calls", () => {
    const root = tempRepo({ ".gdt/roles/developer.md": "Keep commits small.\n" });
    const first = buildPrompt("developer", dispatch(), { root });

    writeFileSync(rulesPath(root, "developer"), "Keep commits even smaller.\n");
    const second = buildPrompt("developer", dispatch(), { root });

    expect(first).toContain("## Role rules\n\nKeep commits small.");
    expect(second).toContain("## Role rules\n\nKeep commits even smaller.");
    expect(second).not.toContain("Keep commits small.");
  });
});

describe("AC-4: gdt init creates the three empty files", () => {
  it("creates all three empty and names them in the output", () => {
    const root = tempRepo();
    const result = gdt(["init", ...SPECS, "--required-check", "test"], root);

    expect(result.code).toBe(0);
    for (const role of ["developer", "tester", "reviewer"]) {
      const path = rulesPath(root, role);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBe(0);
      expect(result.stdout).toContain(`created .gdt/roles/${role}.md`);
    }
  });

  it("leaves an existing file byte-for-byte unchanged, also with --force", () => {
    const root = tempRepo({ [CONFIG]: EXAMPLE_CONFIG, ".gdt/roles/tester.md": "x" });
    const result = gdt(["init", ...SPECS, "--required-check", "test", "--force"], root);

    expect(result.code).toBe(0);
    expect(readFileSync(rulesPath(root, "tester"), "utf8")).toBe("x");
    expect(existsSync(rulesPath(root, "developer"))).toBe(true);
    expect(existsSync(rulesPath(root, "reviewer"))).toBe(true);
    expect(result.stdout).toContain("created .gdt/roles/developer.md");
    expect(result.stdout).toContain("created .gdt/roles/reviewer.md");
    expect(result.stdout).not.toContain("created .gdt/roles/tester.md");
  });
});

describe("AC-5: gdt init leaves the role rules files alone when it refuses", () => {
  it("creates nothing under .gdt/roles without --force", () => {
    const root = tempRepo({ [CONFIG]: EXAMPLE_CONFIG });
    const result = gdt(["init", ...SPECS, "--required-check", "test"], root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(".gdt/config.toml already exists; use --force to replace it");
    expect(existsSync(join(root, ".gdt", "roles"))).toBe(false);
  });
});

describe("AC-6: documentation names the role rules files", () => {
  it("explains the role rules files in README and docs/design.md", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain(".gdt/roles/tester.md");
    expect(readme).toContain("## Role rules");
    expect(readme.replace(/\s+/g, " ")).toMatch(/gdt init`? creates the three files empty/);

    const design = readFileSync("docs/design.md", "utf8");
    expect(design).toContain(".gdt/roles/<role>.md");
    // Section 9 lists the role rules file among what the worker injects per turn.
    expect(design).toContain("role rules");
  });
});
