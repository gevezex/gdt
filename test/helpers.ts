import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../src/cli.js";
import { which } from "../src/doctor.js";

export const EXAMPLE_CONFIG = `language = "nl"                 # language for human-facing GitHub text

[roles.developer]
agent = "opencode"
model = "deepseek/deepseek-v4-flash"

[roles.tester]
agent = "claude"
model = "claude-sonnet-5"

[roles.reviewer]
agent = "codex"
model = "gpt-5.6-luna"

[workflow]
max_correction_rounds = 2       # Round 0 = first delivery, then corrections
required_checks = ["backend-tests", "frontend-checks"]
allow_no_required_checks = false
terminal = "herdr"              # "herdr" | "headless"

[contract]
max_acceptance_criteria = 8
`;

const found = which("git", process.env);
if (found === null) throw new Error("tests need git on PATH");
const realGit: string = found;

/** A PATH containing only the requested tools; `gh` is a stub whose `auth status` exits with `ghAuthExit`. */
export function fakePath(tools: { git?: boolean; gh?: boolean; ghAuthExit?: number } = {}): string {
  const bin = mkdtempSync(join(tmpdir(), "gdt-bin-"));
  if (tools.git ?? true) symlinkSync(realGit, join(bin, "git"));
  if (tools.gh ?? true) {
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nexit ${tools.ghAuthExit ?? 0}\n`);
    chmodSync(join(bin, "gh"), 0o755);
  }
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
