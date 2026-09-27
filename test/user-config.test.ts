import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import type { DoctorReport } from "../src/doctor.js";
import { EXAMPLE_CONFIG, EXAMPLE_USER_CONFIG, fakePath, tempRepo, writeUserConfig } from "./helpers.js";

/** The user config path when `HOME` is `home`, matching `userConfigPath` in src/config.ts. */
function userPath(home: string): string {
  return join(home, ".config", "gdt", "config.toml");
}

/** `gdt doctor --json` with an explicit HOME/XDG environment and a fake PATH. */
function doctor(root: string, env: Record<string, string | undefined>) {
  let stdout = "";
  let stderr = "";
  const code = run(["doctor", "--json"], {
    cwd: root,
    env: { PATH: fakePath(), ...env },
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr, report: JSON.parse(stdout) as DoctorReport };
}

function errors(report: DoctorReport) {
  return report.findings.filter((finding) => finding.level === "error");
}

/** A fresh HOME with the example user config, so no test touches the real home directory. */
function homeWithRoles(text = EXAMPLE_USER_CONFIG): string {
  const home = mkdtempSync(join(tmpdir(), "gdt-home-"));
  writeUserConfig(home, text);
  return home;
}

describe("AC-1: roles are read from the user config, and the local config overrides them", () => {
  it("reads the roles from the user config and reports its absolute path", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    const home = homeWithRoles();

    const { code, report } = doctor(root, { HOME: home });

    expect(report.config.valid).toBe(true);
    if (!report.config.valid) return;
    expect(report.config.roles.developer.source).toBe(userPath(home));
    expect(report.config.roles.tester.source).toBe(userPath(home));
    expect(code).toBe(0);
  });

  it("lets the local config override a role and shows the local file as its source", () => {
    const root = tempRepo({
      ".gdt/config.toml": EXAMPLE_CONFIG,
      ".gdt/config.local.toml": '[roles.reviewer]\nmodel = "gpt-6-sol"\n',
    });
    const home = homeWithRoles();

    const { report } = doctor(root, { HOME: home });

    expect(report.config.valid).toBe(true);
    if (!report.config.valid) return;
    expect(report.config.roles.reviewer.model).toBe("gpt-6-sol");
    expect(report.config.roles.reviewer.source).toBe(".gdt/config.local.toml");
    expect(report.config.roles.developer.source).toBe(userPath(home));
  });

  it("uses an absolute XDG_CONFIG_HOME", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    const home = mkdtempSync(join(tmpdir(), "gdt-home-"));
    const xdg = mkdtempSync(join(tmpdir(), "gdt-xdg-"));
    mkdirSync(join(xdg, "gdt"), { recursive: true });
    writeFileSync(join(xdg, "gdt", "config.toml"), EXAMPLE_USER_CONFIG);

    const { report } = doctor(root, { HOME: home, XDG_CONFIG_HOME: xdg });

    expect(report.config.valid).toBe(true);
    if (!report.config.valid) return;
    expect(report.config.roles.tester.source).toBe(join(xdg, "gdt", "config.toml"));
  });

  it("ignores a relative XDG_CONFIG_HOME, as the XDG specification requires", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    const home = homeWithRoles();

    const { report } = doctor(root, { HOME: home, XDG_CONFIG_HOME: "relative/config" });

    expect(report.config.valid).toBe(true);
    if (!report.config.valid) return;
    expect(report.config.roles.tester.source).toBe(userPath(home));
  });
});

describe("AC-2: roles in the repository config are an error", () => {
  const withRole = `${EXAMPLE_CONFIG}\n[roles.tester]\nagent = "claude"\nmodel = "claude-sonnet-5"\n`;

  it("reports one config error per role table, with a fix naming the user config", () => {
    const root = tempRepo({ ".gdt/config.toml": withRole });
    const home = homeWithRoles();

    const { code, report } = doctor(root, { HOME: home });

    expect(report.config.valid).toBe(false);
    expect(errors(report)).toContainEqual({
      check: "config",
      level: "error",
      message: "roles.tester: not allowed in .gdt/config.toml",
      fix: `Move roles.tester to ${userPath(home)} or .gdt/config.local.toml`,
    });
    expect(code).toBe(1);
  });

  it("reports every role table found", () => {
    const two = `${EXAMPLE_CONFIG}\n[roles.tester]\nagent = "claude"\nmodel = "m"\n\n[roles.reviewer]\nagent = "codex"\nmodel = "m"\n`;
    const root = tempRepo({ ".gdt/config.toml": two });
    const home = homeWithRoles();

    const messages = errors(doctor(root, { HOME: home }).report).map((finding) => finding.message);

    expect(messages).toContain("roles.tester: not allowed in .gdt/config.toml");
    expect(messages).toContain("roles.reviewer: not allowed in .gdt/config.toml");
  });

  it("gdt start refuses with the same message", () => {
    const root = tempRepo({ ".gdt/config.toml": withRole });
    const home = homeWithRoles();
    let stderr = "";

    run(["start", "12"], {
      cwd: root,
      env: { PATH: fakePath(), HOME: home },
      stdout: () => {},
      stderr: (text) => (stderr += text),
    });

    expect(stderr).toContain("roles.tester: not allowed in .gdt/config.toml");
  });
});

describe("AC-3: the user config holds only roles and must be valid TOML", () => {
  it("reports a key outside roles, naming the key and the user config path", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    const home = homeWithRoles(`[workflow]\nterminal = "headless"\n\n${EXAMPLE_USER_CONFIG}`);

    const { code, report } = doctor(root, { HOME: home });

    expect(errors(report)).toContainEqual({
      check: "config",
      level: "error",
      message: `workflow: not allowed in ${userPath(home)}`,
      fix: "Move workflow to .gdt/config.toml",
    });
    expect(report.config.valid).toBe(false);
    expect(code).toBe(1);
  });

  it("reports invalid TOML with the user config path, line and column", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    const home = homeWithRoles("language = \n");

    const messages = errors(doctor(root, { HOME: home }).report).map((finding) => finding.message).join("\n");

    expect(messages).toContain(`${userPath(home)}: invalid TOML at line 1`);
    expect(messages).toMatch(/column \d+/);
  });
});

describe("AC-4: missing roles point to the user config", () => {
  it("reports every missing role with the user config path and the gdt init command", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    const home = mkdtempSync(join(tmpdir(), "gdt-home-"));

    const { code, report } = doctor(root, { HOME: home });

    expect(report.config.valid).toBe(false);
    expect(errors(report).map((finding) => finding.message)).toEqual([
      "roles.developer: missing",
      "roles.tester: missing",
      "roles.reviewer: missing",
    ]);
    for (const finding of errors(report)) {
      expect(finding.fix).toContain(userPath(home));
      expect(finding.fix).toContain(
        "gdt init --developer <agent>/<model> --tester <agent>/<model> --reviewer <agent>/<model>",
      );
    }
    expect(code).toBe(1);
  });

  it("reports only the roles the user config does not define", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    const home = homeWithRoles('[roles.developer]\nagent = "opencode"\nmodel = "m"\n');

    const messages = errors(doctor(root, { HOME: home }).report).map((finding) => finding.message);

    expect(messages).toEqual(["roles.tester: missing", "roles.reviewer: missing"]);
  });

  it("still reports a missing repository config", () => {
    const root = tempRepo();
    const home = homeWithRoles();

    const { report, findings } = loadConfig(root, { HOME: home });

    expect(report.valid).toBe(false);
    expect(findings).toContainEqual(expect.objectContaining({ message: ".gdt/config.toml: not found" }));
  });
});

describe("AC-7: example configs in the repository", () => {
  const read = (name: string) => readFileSync(join("examples", name), "utf8");

  it("loads the three files as user, repository and local layers into a valid config", () => {
    const root = tempRepo({
      ".gdt/config.toml": read("config.toml"),
      ".gdt/config.local.toml": read("config.local.toml"),
    });
    const home = homeWithRoles(read("user-config.toml"));

    const { report } = loadConfig(root, { HOME: home });

    expect(report.valid).toBe(true);
    if (!report.valid) return;
    expect(report.roles.reviewer.model).toBe("gpt-6-sol");
    expect(report.roles.reviewer.source).toBe(".gdt/config.local.toml");
    expect(report.roles.developer.source).toBe(userPath(home));
  });

  it("config.toml has every non-role key with a comment and no role table", () => {
    const text = read("config.toml");
    expect(text).toContain('herdr_layout = "tabs"');
    expect(text).not.toMatch(/^\[roles\./m);
    for (const key of [
      "language",
      "max_correction_rounds",
      "required_checks",
      "allow_no_required_checks",
      "terminal",
      "supervisor_pane",
      "herdr_layout",
      "poll_seconds",
      "handoff_checks",
      "max_acceptance_criteria",
    ]) {
      expect(text).toMatch(new RegExp(`^${key} = .*#`, "m"));
    }
  });

  it("user-config.toml has all three roles and config.local.toml overrides one model", () => {
    const user = read("user-config.toml");
    for (const role of ["developer", "tester", "reviewer"]) {
      expect(user).toContain(`[roles.${role}]`);
      expect(user).toMatch(new RegExp(`^\\[roles\\.${role}\\]\\nagent = .*#.*\\nmodel = .*#`, "m"));
    }
    const local = read("config.local.toml");
    expect(local).toContain("[roles.reviewer]");
    expect(local).toMatch(/^model = .*#/m);
  });
});

describe("AC-8: documentation and this repository's config follow the new layout", () => {
  it("this repository's .gdt/config.toml has no role table and keeps its keys", () => {
    const config = readFileSync(".gdt/config.toml", "utf8");
    expect(config).not.toMatch(/^\[roles\./m);
    expect(config).toContain('language = "en"');
    expect(config).toContain('required_checks = ["test"]');
  });

  it("README names the three files with their merge order and links to examples/", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("~/.config/gdt/config.toml");
    expect(readme).toContain(".gdt/config.local.toml");
    expect(readme).toMatch(/examples\//);
  });

  it("README Quick start says gdt init writes the roles to the user config", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme.replace(/\s+/g, " ")).toMatch(/gdt init`? writes the roles to the user config/);
  });

  it("docs/design.md section 4 describes the user, repository and local config", () => {
    const design = readFileSync("docs/design.md", "utf8");
    expect(design).toContain("user config");
    expect(design).toContain("$XDG_CONFIG_HOME/gdt/config.toml");
  });

  it("skill/SKILL.md says where gdt init writes the roles", () => {
    const skill = readFileSync("skill/SKILL.md", "utf8");
    expect(skill.replace(/\s+/g, " ")).toMatch(/user config/i);
  });
});
