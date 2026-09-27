import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.js";
import { which } from "../src/doctor.js";

const FAKE_HERDR = fileURLToPath(new URL("./fixtures/fake-herdr.mjs", import.meta.url));

/** Writes a `herdr` stand-in into `bin`, backed by the shared fixture. */
export function fakeHerdr(bin: string, version = "0.9.1"): void {
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh\nFAKE_HERDR_DIR="\${0%/*}" FAKE_HERDR_VERSION="${version}" exec "${process.execPath}" "${FAKE_HERDR}" "$@"\n`,
  );
  chmodSync(join(bin, "herdr"), 0o755);
}

/** The project settings of a repository config; roles live in the user config (issue #51). */
export const EXAMPLE_CONFIG = `language = "nl"                 # language for human-facing GitHub text

[workflow]
max_correction_rounds = 2       # Round 0 = first delivery, then corrections
required_checks = ["backend-tests", "frontend-checks"]
allow_no_required_checks = false
terminal = "herdr"              # "herdr" | "headless"

[contract]
max_acceptance_criteria = 8
`;

/** The three roles a user config may define. */
export const EXAMPLE_USER_CONFIG = `[roles.developer]
agent = "opencode"
model = "deepseek/deepseek-v4-flash"

[roles.tester]
agent = "claude"
model = "claude-sonnet-5"

[roles.reviewer]
agent = "codex"
model = "gpt-5.6-luna"
`;

/** The user config path under `root` when `HOME` is `root` (the convention in these tests). */
export const USER_CONFIG = join(".config", "gdt", "config.toml");

/** Writes the user config under `root`, creating the directory; a test may pass a custom text. */
export function writeUserConfig(root: string, text = EXAMPLE_USER_CONFIG): void {
  const path = join(root, USER_CONFIG);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const found = which("git", process.env);
if (found === null) throw new Error("tests need git on PATH");
const realGit: string = found;

export interface FakeTools {
  git?: boolean;
  gh?: boolean;
  ghAuthExit?: number;
  /** Body returned by `gh issue view <n> --json body`; without it that command fails. */
  issueBody?: string;
  /** Agent CLIs to stub on PATH (default: claude, codex, opencode). */
  agents?: string[];
  /** Install a herdr stand-in (default true); set false to test the missing-herdr path. */
  herdr?: boolean;
  /** Version the herdr stand-in reports. */
  herdrVersion?: string;
}

/**
 * A PATH containing only the requested tools. `gh` is a stub: `issue view` prints `issueBody` as JSON
 * (and logs its arguments to `gh-args` in the bin directory); anything else exits with `ghAuthExit`.
 */
export function fakePath(tools: FakeTools = {}): string {
  const bin = mkdtempSync(join(tmpdir(), "gdt-bin-"));
  if (tools.git ?? true) symlinkSync(realGit, join(bin, "git"));
  if (tools.gh ?? true) {
    const issue =
      tools.issueBody === undefined
        ? `echo "GraphQL: Could not resolve to an issue" >&2; exit 1`
        : `echo "$@" > "${join(bin, "gh-args")}"; /bin/cat "${join(bin, "issue.json")}"; exit 0`;
    if (tools.issueBody !== undefined) writeFileSync(join(bin, "issue.json"), JSON.stringify({ body: tools.issueBody }));
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$1" = "issue" ] && [ "$2" = "view" ]; then ${issue}; fi\nexit ${tools.ghAuthExit ?? 0}\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
  }
  for (const agent of tools.agents ?? ["claude", "codex", "opencode"]) {
    writeFileSync(join(bin, agent), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, agent), 0o755);
  }
  if (tools.herdr ?? true) fakeHerdr(bin, tools.herdrVersion);
  return bin;
}

export function tempRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "gdt-repo-"));
  spawnSync(realGit, ["init", "--quiet"], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

export function gdt(argv: string[], cwd: string, path = fakePath()) {
  // The shared helper keeps roles in the user config, under HOME (= cwd). `gdt init` tests set up
  // their own user-config state, so they are left alone.
  if (argv[0] !== "init" && !existsSync(join(cwd, USER_CONFIG))) writeUserConfig(cwd);
  let stdout = "";
  let stderr = "";
  const code = run(argv, {
    cwd,
    env: { PATH: path, HOME: cwd },
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}
