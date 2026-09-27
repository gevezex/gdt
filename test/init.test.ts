import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { readUserConfig } from "../src/config.js";
import { which } from "../src/doctor.js";
import { fakeHerdr, tempRepo, writeUserConfig } from "./helpers.js";

const FAKE_GH = fileURLToPath(new URL("./fixtures/init-gh.mjs", import.meta.url));

const CONFIG = join(".gdt", "config.toml");

interface InitTools {
  /** Agent binaries to stub on PATH (default claude, codex, opencode). */
  agents?: string[];
  /** Check-run names the fake default branch reports. */
  checks?: string[];
  /** Commit-status contexts the fake default branch reports. */
  statuses?: string[];
  defaultBranch?: string;
  repo?: string;
  /** Make the fake gh fail to resolve the repository, as without a GitHub remote. */
  failRepo?: boolean;
  /** Install a herdr stand-in (default true). */
  herdr?: boolean;
}

/** A PATH with git, the wanted agent stubs, an optional herdr and a fake gh that reports checks. */
function initPath(tools: InitTools = {}): string {
  const bin = mkdtempSync(join(tmpdir(), "gdt-init-bin-"));
  const git = which("git", process.env);
  if (git !== null) symlinkSync(git, join(bin, "git"));
  for (const agent of tools.agents ?? ["claude", "codex", "opencode"]) {
    writeFileSync(join(bin, agent), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, agent), 0o755);
  }
  if (tools.herdr ?? true) fakeHerdr(bin);
  const config = join(bin, "gh.json");
  writeFileSync(
    config,
    JSON.stringify({
      repo: tools.repo ?? "gevezex/demo",
      defaultBranch: tools.defaultBranch ?? "main",
      failRepo: tools.failRepo ?? false,
      checks: tools.checks ?? [],
      statuses: tools.statuses ?? [],
    }),
  );
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "${config}" "$@"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

function runGdt(argv: string[], root: string, path: string, home = root): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = run(argv, {
    cwd: root,
    env: { PATH: path, HOME: home },
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}

const init = (argv: string[], root: string, path: string, home = root) => runGdt(["init", ...argv], root, path, home);
const configPath = (root: string) => join(root, CONFIG);

const SPECS = [
  "--developer",
  "opencode/deepseek/deepseek-v4-flash",
  "--tester",
  "claude/claude-sonnet-5",
  "--reviewer",
  "codex/gpt-5.6-luna",
];

describe("AC-1: without role options, gdt init reports a proposal and writes nothing", () => {
  it("prints one JSON object with the agents, terminal, checks and language", () => {
    const root = tempRepo();
    const path = initPath({ agents: ["claude", "codex"], checks: ["test"] });

    const result = init(["--json"], root, path);

    expect(result.code).toBe(0);
    expect(existsSync(configPath(root))).toBe(false);
    const facts = JSON.parse(result.stdout) as {
      agents: { agent: string; found: boolean; model_format: string; example: string }[];
      terminal: string;
      required_checks: string[];
      language: string;
    };
    expect(facts.language).toBe("en");
    expect(facts.terminal).toBe("herdr");
    expect(facts.required_checks).toEqual(["test"]);
    expect(facts.agents.map((a) => a.agent)).toEqual(["claude", "codex", "opencode", "mcode", "pi", "omp"]);
    for (const choice of facts.agents) {
      expect(choice.model_format).not.toBe("");
      expect(choice.example).not.toBe("");
      expect(typeof choice.found).toBe("boolean");
    }
    const byAgent = Object.fromEntries(facts.agents.map((a) => [a.agent, a]));
    expect(byAgent.claude).toMatchObject({ found: true, model_format: "<model>", example: "claude-sonnet-5" });
    expect(byAgent.codex).toMatchObject({ found: true, example: "gpt-5.6-luna" });
    for (const agent of ["opencode", "mcode", "pi", "omp"]) expect(byAgent[agent]?.found).toBe(false);
  });

  it("reports headless when herdr is not usable", () => {
    const root = tempRepo();
    const path = initPath({ herdr: false });
    const facts = JSON.parse(init(["--json"], root, path).stdout) as { terminal: string };
    expect(facts.terminal).toBe("headless");
  });

  it("prints readable lines with the next gdt init command without --json", () => {
    const root = tempRepo();
    const path = initPath({ agents: ["claude"], checks: ["test"] });
    const result = init([], root, path);
    expect(result.code).toBe(0);
    expect(existsSync(configPath(root))).toBe(false);
    expect(result.stdout).toContain("claude");
    expect(result.stdout).toContain("found");
    expect(result.stdout).toContain("terminal: herdr");
    expect(result.stdout).toContain("required_checks: test");
    expect(result.stdout).toContain("language: en");
    expect(result.stdout).toContain("gdt init --developer");
  });
});

describe("AC-2: with all three role specs, gdt init writes a valid config", () => {
  it("writes the roles to the user config and the checks to a role-free repository config", () => {
    const root = tempRepo();
    const path = initPath({ checks: ["lost"] });

    const result = init([...SPECS, "--required-check", "test"], root, path);

    expect(result.code).toBe(0);
    const config = readFileSync(configPath(root), "utf8");
    expect(config).toContain('required_checks = ["test"]');
    // language, terminal and allow_no_required_checks keep their default and are not written.
    expect(config).not.toContain("[roles.");
    expect(config).not.toContain("language =");
    expect(config).not.toContain("terminal =");
    expect(config).not.toContain("allow_no_required_checks");

    const user = readFileSync(join(root, ".config", "gdt", "config.toml"), "utf8");
    expect(user).toContain('[roles.developer]\nagent = "opencode"\nmodel = "deepseek/deepseek-v4-flash"');
    expect(user).toContain('[roles.tester]\nagent = "claude"\nmodel = "claude-sonnet-5"');
    expect(user).toContain('[roles.reviewer]\nagent = "codex"\nmodel = "gpt-5.6-luna"');
  });

  it("is accepted by gdt doctor", () => {
    const root = tempRepo();
    const path = initPath();
    init([...SPECS, "--required-check", "test"], root, path);
    const doctor = runGdt(["doctor", "--json"], root, path);
    const report = JSON.parse(doctor.stdout) as { config: { valid: boolean } };
    expect(report.config.valid).toBe(true);
    expect(doctor.code).toBe(0);
  });

  it("writes a non-default language and terminal", () => {
    const root = tempRepo();
    const path = initPath();
    const result = init([...SPECS, "--language", "nl", "--terminal", "headless", "--required-check", "test"], root, path);
    expect(result.code).toBe(0);
    const text = readFileSync(configPath(root), "utf8");
    expect(text).toContain('language = "nl"');
    expect(text).toContain('terminal = "headless"');
  });

  it("uses the detected checks when none are given", () => {
    const root = tempRepo();
    const path = initPath({ checks: ["zeta", "alpha"], statuses: ["alpha", "beta"] });
    const result = init([...SPECS], root, path);
    expect(result.code).toBe(0);
    expect(readFileSync(configPath(root), "utf8")).toContain('required_checks = ["alpha", "beta", "zeta"]');
  });
});

describe("AC-3: an existing config is never overwritten without --force", () => {
  it("exits 1, names --force and leaves the file byte-for-byte unchanged", () => {
    const existing = "language = \"en\"\n# untouched\n";
    const root = tempRepo({ [CONFIG]: existing });
    const path = initPath();

    const result = init([...SPECS, "--required-check", "test"], root, path);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(".gdt/config.toml already exists; use --force to replace it");
    expect(readFileSync(configPath(root), "utf8")).toBe(existing);
  });

  it("replaces the file with --force", () => {
    const root = tempRepo({ [CONFIG]: "language = \"en\"\n" });
    const path = initPath();
    const result = init([...SPECS, "--required-check", "test", "--force"], root, path);
    expect(result.code).toBe(0);
    expect(readFileSync(configPath(root), "utf8")).toContain('required_checks = ["test"]');
  });
});

describe("AC-4: no required checks is an error unless the user opts out", () => {
  it("exits 1, writes nothing and names both options", () => {
    const root = tempRepo();
    const path = initPath({ checks: [] });
    const result = init([...SPECS], root, path);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--required-check <name>");
    expect(result.stderr).toContain("--allow-no-required-checks");
    expect(existsSync(configPath(root))).toBe(false);
  });

  it("treats a repository gh cannot read as having no detected checks", () => {
    const root = tempRepo();
    const facts = JSON.parse(init(["--json"], root, initPath({ failRepo: true })).stdout) as { required_checks: string[] };
    expect(facts.required_checks).toEqual([]);
  });

  it("writes an empty list and the opt-out with --allow-no-required-checks", () => {
    const root = tempRepo();
    const path = initPath({ checks: [] });
    const result = init([...SPECS, "--allow-no-required-checks"], root, path);
    expect(result.code).toBe(0);
    const text = readFileSync(configPath(root), "utf8");
    expect(text).toContain("required_checks = []");
    expect(text).toContain("allow_no_required_checks = true");
    expect(runGdt(["doctor"], root, path).code).toBe(0);
  });
});

describe("AC-5: invalid options write nothing", () => {
  it("exits 2 and names a missing role option", () => {
    const root = tempRepo();
    const path = initPath();
    const result = init(["--developer", "claude/claude-sonnet-5"], root, path);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('"--tester"');
    expect(result.stderr).toContain('"--reviewer"');
    expect(existsSync(configPath(root))).toBe(false);
  });

  it("rejects an unsupported agent with exit 1 and lists the supported agents", () => {
    const root = tempRepo();
    const path = initPath();
    const result = init(["--developer", "foo/bar", "--tester", "claude/claude-sonnet-5", "--reviewer", "codex/gpt-5.6-luna"], root, path);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('Unsupported agent "foo"; supported agents: claude, codex, opencode, mcode, pi, omp\n');
    expect(existsSync(configPath(root))).toBe(false);
  });

  it("rejects an empty model with exit 1 and shows the form", () => {
    const root = tempRepo();
    const path = initPath();
    const result = init(["--developer", "claude/", "--tester", "claude/claude-sonnet-5", "--reviewer", "codex/gpt-5.6-luna"], root, path);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("<agent>/<model>");
    expect(existsSync(configPath(root))).toBe(false);
  });

  it("rejects an unknown language with exit 1 and lists the available languages", () => {
    const root = tempRepo();
    const path = initPath();
    const result = init([...SPECS, "--language", "xx", "--required-check", "test"], root, path);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No locale for language "xx"');
    expect(result.stderr).toContain("en");
    expect(result.stderr).toContain("nl");
    expect(existsSync(configPath(root))).toBe(false);
  });
});

describe("AC-6: developer and tester with one vendor are allowed with a warning", () => {
  it("writes the config and prints the doctor warning", () => {
    const root = tempRepo();
    const path = initPath({ agents: ["claude", "codex"] });
    const result = init(
      ["--developer", "claude/claude-sonnet-5", "--tester", "claude/claude-opus-5-5", "--reviewer", "codex/gpt-5.6-luna", "--required-check", "test"],
      root,
      path,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "developer and tester both use anthropic; use a different vendor for the tester for independent verification",
    );
    expect(existsSync(configPath(root))).toBe(true);
  });
});

describe("AC-7: after writing, gdt init runs doctor and installs the skill", () => {
  it("reports the doctor error and the skipped skill, keeps the config and exits 1", () => {
    const root = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdt-init-home-"));
    const path = initPath({ agents: ["claude", "opencode"] });
    const result = init([...SPECS, "--required-check", "test"], root, path, home);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("roles.reviewer: codex not found on PATH");
    expect(result.stdout).toContain("skipped: codex not found");
    expect(existsSync(configPath(root))).toBe(true);
  });

  it("installs the skill, keeps the config and exits 0 when doctor is clean", () => {
    const root = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdt-init-home-"));
    const path = initPath();
    const result = init([...SPECS, "--required-check", "test"], root, path, home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("installed");
    expect(existsSync(join(home, ".claude/skills/gdt/SKILL.md"))).toBe(true);
    expect(existsSync(configPath(root))).toBe(true);
  });
});

describe("AC-8: the operator skill and README use gdt init", () => {
  it("tells the operator to run gdt init --json and then gdt init with the user's choices", () => {
    const skill = readFileSync("skill/SKILL.md", "utf8");
    expect(skill).toContain("gdt init --json");
    expect(skill).toContain(".gdt/config.toml");
  });

  it("README creates the config with gdt init", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("gdt init --developer");
  });

  it("gdt --help lists init and gdt init --help lists every option", () => {
    const root = tempRepo();
    const path = initPath();
    const help = init(["--help"], root, path);
    expect(help.code).toBe(0);
    for (const option of [
      "--developer",
      "--tester",
      "--reviewer",
      "--language",
      "--terminal",
      "--required-check",
      "--allow-no-required-checks",
      "--force",
    ]) {
      expect(help.stdout).toContain(option);
    }
    expect(runGdt(["--help"], root, path).stdout).toContain("init");
  });
});

// Issue #51: the roles moved from the repository config to the per-user config.

const USER_CONFIG = join(".config", "gdt", "config.toml");

describe("AC-5 (issue #51): gdt init with role options writes the roles to the user config", () => {
  it("writes the roles to the user config and a role-free repository config", () => {
    const root = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdt-init-home-"));
    const path = initPath();
    const result = init([...SPECS, "--required-check", "test"], root, path, home);

    expect(result.code).toBe(0);
    const user = readFileSync(join(home, USER_CONFIG), "utf8");
    expect(user).toContain('[roles.developer]\nagent = "opencode"\nmodel = "deepseek/deepseek-v4-flash"');
    expect(user).toContain('[roles.reviewer]\nagent = "codex"\nmodel = "gpt-5.6-luna"');
    const config = readFileSync(configPath(root), "utf8");
    expect(config).toContain('required_checks = ["test"]');
    expect(config).not.toContain("[roles.");
  });

  it("refuses without --force when the user config already defines a role, writing neither file", () => {
    const root = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdt-init-home-"));
    writeUserConfig(home, '[roles.developer]\nagent = "claude"\nmodel = "old"\n');
    const before = readFileSync(join(home, USER_CONFIG), "utf8");

    const result = init([...SPECS, "--required-check", "test"], root, initPath(), home);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--force");
    expect(existsSync(configPath(root))).toBe(false);
    expect(readFileSync(join(home, USER_CONFIG), "utf8")).toBe(before);
  });

  it("replaces only the role tables of the user config with --force", () => {
    const root = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdt-init-home-"));
    writeUserConfig(home, '# keep this comment\n[roles.developer]\nagent = "claude"\nmodel = "old"\n');

    const result = init([...SPECS, "--required-check", "test", "--force"], root, initPath(), home);

    expect(result.code).toBe(0);
    const user = readFileSync(join(home, USER_CONFIG), "utf8");
    expect(user).toContain("# keep this comment");
    expect(user).toContain('[roles.developer]\nagent = "opencode"\nmodel = "deepseek/deepseek-v4-flash"');
    expect(user).not.toContain('model = "old"');
  });

  // R-1: roles expressed as a `[roles]` table with inline entries must be replaced too, not only
  // the `[roles.<role>]` table syntax, or the rewrite leaves a duplicate definition.
  it("replaces roles written as inline tables under [roles] with --force", () => {
    const root = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdt-init-home-"));
    writeUserConfig(
      home,
      '[roles]\ndeveloper = { agent = "claude", model = "old-dev" }\ntester = { agent = "claude", model = "old-test" }\nreviewer = { agent = "claude", model = "old-rev" }\n',
    );

    const result = init([...SPECS, "--required-check", "test", "--force"], root, initPath(), home);

    expect(result.code).toBe(0);
    const user = readFileSync(join(home, USER_CONFIG), "utf8");
    expect(user).not.toContain("old-dev");
    expect(user).not.toContain("[roles]");
    const reread = readUserConfig({ HOME: home });
    expect(reread.findings).toEqual([]);
    expect(reread.roles.developer).toMatchObject({ agent: "opencode", model: "deepseek/deepseek-v4-flash" });
    expect(reread.roles.tester).toMatchObject({ agent: "claude", model: "claude-sonnet-5" });
    expect(reread.roles.reviewer).toMatchObject({ agent: "codex", model: "gpt-5.6-luna" });
  });

  it("replaces roles written as a top-level inline table or dotted keys with --force", () => {
    for (const text of [
      'roles = { developer = { agent = "claude", model = "old-dev" }, tester = { agent = "claude", model = "old-test" }, reviewer = { agent = "claude", model = "old-rev" } }\n',
      'roles.developer.agent = "claude"\nroles.developer.model = "old-dev"\nroles.tester.agent = "claude"\nroles.tester.model = "old-test"\nroles.reviewer.agent = "claude"\nroles.reviewer.model = "old-rev"\n',
    ]) {
      const root = tempRepo();
      const home = mkdtempSync(join(tmpdir(), "gdt-init-home-"));
      writeUserConfig(home, text);

      const result = init([...SPECS, "--required-check", "test", "--force"], root, initPath(), home);

      expect(result.code).toBe(0);
      const user = readFileSync(join(home, USER_CONFIG), "utf8");
      expect(user).not.toContain("old-dev");
      const reread = readUserConfig({ HOME: home });
      expect(reread.findings).toEqual([]);
      expect(reread.roles.developer).toMatchObject({ agent: "opencode", model: "deepseek/deepseek-v4-flash" });
      expect(reread.roles.reviewer).toMatchObject({ agent: "codex", model: "gpt-5.6-luna" });
    }
  });
});

describe("AC-6 (issue #51): gdt init without role options reuses the roles from the user config", () => {
  it("writes a role-free repository config, leaves the user config unchanged and names it", () => {
    const root = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdt-init-home-"));
    writeUserConfig(home);
    const before = readFileSync(join(home, USER_CONFIG), "utf8");
    const path = initPath({ checks: ["test"] });

    const result = init([], root, path, home);

    expect(result.code).toBe(0);
    const config = readFileSync(configPath(root), "utf8");
    expect(config).toContain('required_checks = ["test"]');
    expect(config).not.toContain("[roles.");
    expect(readFileSync(join(home, USER_CONFIG), "utf8")).toBe(before);
    expect(result.stdout).toContain(join(home, USER_CONFIG));
  });

  it("only reports the proposal when the user config does not define all three roles", () => {
    const root = tempRepo();
    const home = mkdtempSync(join(tmpdir(), "gdt-init-home-"));
    writeUserConfig(home, '[roles.developer]\nagent = "claude"\nmodel = "claude-sonnet-5"\n');
    const path = initPath({ checks: ["test"] });

    const result = init([], root, path, home);

    expect(result.code).toBe(0);
    expect(existsSync(configPath(root))).toBe(false);
    expect(result.stdout).toContain("gdt init --developer");
  });
});
