import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DoctorReport } from "../src/doctor.js";
import { EXAMPLE_CONFIG, EXAMPLE_USER_CONFIG, fakePath, gdt, tempRepo, USER_CONFIG, writeUserConfig } from "./helpers.js";

function doctorJson(root: string, path?: string) {
  const result = gdt(["doctor", "--json"], root, path);
  return { ...result, report: JSON.parse(result.stdout) as DoctorReport };
}

function withKey(config: string, table: string, line: string): string {
  return config.replace(`[${table}]\n`, `[${table}]\n${line}\n`);
}

function errors(report: DoctorReport) {
  return report.findings.filter((f) => f.level === "error");
}

describe("AC-3: valid configuration is reported", () => {
  it("reports the resolved roles, well-formed findings and exits 0", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    writeUserConfig(root);
    const userPath = join(root, USER_CONFIG);
    const { code, stdout, report } = doctorJson(root);

    // The exact JSON path from the issue, independent of the TypeScript types.
    const json = JSON.parse(stdout) as { config: Record<string, unknown> & { roles: Record<string, unknown> } };
    expect(json.config.valid).toBe(true);
    expect(json.config.roles.tester).toEqual({ agent: "claude", model: "claude-sonnet-5", source: userPath });
    expect(json.config).not.toHaveProperty("config");

    expect(report.config.valid).toBe(true);
    if (!report.config.valid) return;
    expect(report.config.roles).toEqual({
      developer: { agent: "opencode", model: "deepseek/deepseek-v4-flash", source: userPath },
      tester: { agent: "claude", model: "claude-sonnet-5", source: userPath },
      reviewer: { agent: "codex", model: "gpt-5.6-luna", source: userPath },
    });
    expect(report.findings.length).toBeGreaterThan(0);
    for (const finding of report.findings) {
      expect(Object.keys(finding).sort()).toEqual(["check", "fix", "level", "message"]);
      expect(["ok", "warning", "error"]).toContain(finding.level);
    }
    expect(errors(report)).toEqual([]);
    expect(code).toBe(0);
  });

  it("reports no contract.extra_rules finding when the key is not configured", () => {
    const { report } = doctorJson(tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG }));
    expect(report.findings.map((f) => f.check)).not.toContain("contract.extra_rules");
  });
});

describe("contract.extra_rules", () => {
  const config = withKey(EXAMPLE_CONFIG, "contract", 'extra_rules = ".gdt/rules.md"');

  it("is ok when the configured file exists", () => {
    const { code, report } = doctorJson(tempRepo({ ".gdt/config.toml": config, ".gdt/rules.md": "" }));
    expect(report.findings).toContainEqual({
      check: "contract.extra_rules",
      level: "ok",
      message: "contract.extra_rules: .gdt/rules.md found",
      fix: "",
    });
    expect(code).toBe(0);
  });

  it("is an error when the configured file is missing", () => {
    const { code, report } = doctorJson(tempRepo({ ".gdt/config.toml": config }));
    expect(errors(report)).toContainEqual(
      expect.objectContaining({ check: "contract.extra_rules", message: "contract.extra_rules: .gdt/rules.md not found" }),
    );
    expect(code).toBe(1);
  });

  it("applies defaults for optional keys", () => {
    const minimal = EXAMPLE_CONFIG.replace(/^language.*\n/, "")
      .replace(/^max_correction_rounds.*\n/m, "")
      .replace(/^terminal.*\n/m, "")
      .replace(/\[contract\][\s\S]*$/, "");
    const { report } = doctorJson(tempRepo({ ".gdt/config.toml": minimal }));
    expect(report.config.valid).toBe(true);
    if (!report.config.valid) return;
    expect(report.config.language).toBe("en");
    expect(report.config.workflow).toMatchObject({ max_correction_rounds: 2, terminal: "herdr" });
    expect(report.config.contract).toEqual({ max_acceptance_criteria: 8 });
  });
});

describe("AC-4: invalid configuration names the key and allowed values", () => {
  const badAgent = EXAMPLE_USER_CONFIG.replace('agent = "claude"', 'agent = "foo"');

  function badAgentRepo() {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    writeUserConfig(root, badAgent);
    return root;
  }

  it("reports an unsupported agent and exits 1", () => {
    const result = gdt(["doctor"], badAgentRepo());
    expect(result.stdout).toContain('roles.tester.agent: "foo" is not one of claude, codex, opencode, mcode, pi, omp');
    expect(result.code).toBe(1);
  });

  it("reports the offending key as an error finding in JSON", () => {
    const root = badAgentRepo();
    const { code, report } = doctorJson(root);
    expect(report.config.valid).toBe(false);
    expect(errors(report)).toContainEqual({
      check: "config",
      level: "error",
      message: 'roles.tester.agent: "foo" is not one of claude, codex, opencode, mcode, pi, omp',
      fix: `Set roles.tester.agent in ${join(root, USER_CONFIG)} to one of claude, codex, opencode, mcode, pi, omp`,
    });
    expect(code).toBe(1);
  });

  it("reports a missing role", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    writeUserConfig(root, EXAMPLE_USER_CONFIG.replace(/\[roles\.reviewer\]\n.*\n.*\n/, ""));
    const { code, report } = doctorJson(root);
    expect(errors(report).map((f) => f.message).join("\n")).toContain("roles.reviewer: missing");
    expect(report.config.valid).toBe(false);
    expect(code).toBe(1);
  });

  it.each([
    [
      "a wrong type",
      EXAMPLE_CONFIG.replace("max_correction_rounds = 2", 'max_correction_rounds = "two"'),
      'workflow.max_correction_rounds: expected number, got "two"',
    ],
    ["an unknown key", withKey(EXAMPLE_CONFIG, "workflow", "requierd_checks = []"), "workflow.requierd_checks: unknown key"],
    ["a missing required_checks", EXAMPLE_CONFIG.replace(/^required_checks.*\n/m, ""), "workflow.required_checks: missing"],
    ["invalid TOML", "language = \n", ".gdt/config.toml: invalid TOML at line 1"],
  ])("reports %s", (_name, config, message) => {
    const { code, report } = doctorJson(tempRepo({ ".gdt/config.toml": config }));
    expect(errors(report).map((f) => f.message).join("\n")).toContain(message);
    expect(report.config.valid).toBe(false);
    expect(code).toBe(1);
  });

  it("reports a missing config file", () => {
    const { code, report } = doctorJson(tempRepo());
    expect(errors(report)).toContainEqual(expect.objectContaining({ message: ".gdt/config.toml: not found" }));
    expect(code).toBe(1);
  });

  it("reports a directory outside a Git repository", () => {
    const { code, report } = doctorJson(fakePath());
    expect(errors(report)).toContainEqual(expect.objectContaining({ check: "repository" }));
    expect(code).toBe(1);
  });
});

describe("AC-5: local override wins and shows its source", () => {
  it("resolves the local model with its source and excludes the file exactly once", () => {
    const root = tempRepo({
      ".gdt/config.toml": EXAMPLE_CONFIG,
      ".gdt/config.local.toml": '[roles.tester]\nmodel = "claude-haiku-4-5"\n',
    });
    writeUserConfig(root);

    for (let run = 0; run < 2; run++) {
      const { report } = doctorJson(root);
      expect(report.config.valid).toBe(true);
      if (!report.config.valid) return;
      expect(report.config.roles.tester).toEqual({
        agent: "claude",
        model: "claude-haiku-4-5",
        source: ".gdt/config.local.toml",
      });
      expect(report.config.roles.developer.source).toBe(join(root, USER_CONFIG));
    }

    const exclude = readFileSync(join(root, ".git/info/exclude"), "utf8").split("\n");
    expect(exclude.filter((line) => line === ".gdt/config.local.toml")).toHaveLength(1);
  });

  it("names the local file when the override is invalid", () => {
    const root = tempRepo({
      ".gdt/config.toml": EXAMPLE_CONFIG,
      ".gdt/config.local.toml": '[roles.tester]\nagent = "foo"\n',
    });
    const { report } = doctorJson(root);
    expect(errors(report)[0]?.fix).toContain(".gdt/config.local.toml");
  });
});

describe("AC-6: an empty required-checks list is not silently accepted", () => {
  const message = "workflow.required_checks is empty; set workflow.allow_no_required_checks = true to accept this";
  const empty = EXAMPLE_CONFIG.replace(/^required_checks.*$/m, "required_checks = []");

  it.each([
    ["false", empty],
    ["absent", empty.replace(/^allow_no_required_checks.*\n/m, "")],
  ])("is an error when allow_no_required_checks is %s", (_name, config) => {
    const { code, report } = doctorJson(tempRepo({ ".gdt/config.toml": config }));
    expect(report.findings).toContainEqual(expect.objectContaining({ level: "error", message }));
    expect(code).toBe(1);
  });

  it("is a warning when allow_no_required_checks = true", () => {
    const config = empty.replace("allow_no_required_checks = false", "allow_no_required_checks = true");
    const { code, report } = doctorJson(tempRepo({ ".gdt/config.toml": config }));
    expect(report.findings).toContainEqual(expect.objectContaining({ level: "warning", message }));
    expect(code).toBe(0);
  });
});

describe("AC-7: missing external tools are reported with a fix", () => {
  const files = { ".gdt/config.toml": EXAMPLE_CONFIG };

  it("reports a missing gh", () => {
    const { code, report } = doctorJson(tempRepo(files), fakePath({ gh: false }));
    expect(errors(report)).toEqual([
      { check: "gh", level: "error", message: "gh: not found on PATH", fix: "Install GitHub CLI: https://cli.github.com" },
    ]);
    expect(code).toBe(1);
  });

  it("reports a missing git", () => {
    const { code, report } = doctorJson(tempRepo(files), fakePath({ git: false }));
    expect(errors(report)).toEqual([
      { check: "git", level: "error", message: "git: not found on PATH", fix: "Install Git: https://git-scm.com/downloads" },
    ]);
    expect(code).toBe(1);
  });

  it("reports an unauthenticated gh", () => {
    const { code, report } = doctorJson(tempRepo(files), fakePath({ ghAuthExit: 1 }));
    expect(errors(report)).toEqual([
      { check: "gh-auth", level: "error", message: "gh: not authenticated to github.com", fix: 'Run "gh auth login"' },
    ]);
    expect(code).toBe(1);
  });
});
