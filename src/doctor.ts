import { spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { type ConfigReport, CONFIG_PATH, LOCAL_CONFIG_PATH, loadConfig } from "./config.js";
import { type Finding, hasErrors } from "./finding.js";

export interface DoctorReport {
  ok: boolean;
  repository: string | null;
  config: ConfigReport;
  findings: Finding[];
}

type Env = Record<string, string | undefined>;

const TOOLS = [
  { name: "git", fix: "Install Git: https://git-scm.com/downloads" },
  { name: "gh", fix: "Install GitHub CLI: https://cli.github.com" },
] as const;

/** Resolves `name` against `env.PATH` like a shell would, without running anything. */
export function which(name: string, env: Env): string | null {
  const extensions = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const ext of extensions) {
      const candidate = join(dir, name + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

/** The nearest directory at or above `cwd` that contains `.git`. */
export function findRepository(cwd: string): string | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

function toolFindings(env: Env): { findings: Finding[]; paths: Map<string, string> } {
  const findings: Finding[] = [];
  const paths = new Map<string, string>();
  for (const tool of TOOLS) {
    const path = which(tool.name, env);
    if (path === null) {
      findings.push({ check: tool.name, level: "error", message: `${tool.name}: not found on PATH`, fix: tool.fix });
    } else {
      paths.set(tool.name, path);
      findings.push({ check: tool.name, level: "ok", message: `${tool.name}: found at ${path}`, fix: "" });
    }
  }
  return { findings, paths };
}

function ghAuthFinding(gh: string, cwd: string, env: Env): Finding {
  const result = spawnSync(gh, ["auth", "status", "--hostname", "github.com"], { cwd, env, encoding: "utf8" });
  if (result.status === 0) {
    return { check: "gh-auth", level: "ok", message: "gh: authenticated to github.com", fix: "" };
  }
  return {
    check: "gh-auth",
    level: "error",
    message: "gh: not authenticated to github.com",
    fix: 'Run "gh auth login"',
  };
}

function excludePath(root: string, git: string | undefined, env: Env): string | null {
  if (git !== undefined) {
    const result = spawnSync(git, ["rev-parse", "--git-path", "info/exclude"], { cwd: root, env, encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim() !== "") return resolve(root, result.stdout.trim());
  }
  const gitDir = join(root, ".git");
  return statSync(gitDir).isDirectory() ? join(gitDir, "info", "exclude") : null;
}

/** Ensures the local override file is ignored by Git without touching the committed .gitignore. */
function excludeFinding(root: string, git: string | undefined, env: Env): Finding {
  const check = "local-config-excluded";
  const fix = `Add the line ${LOCAL_CONFIG_PATH} to .git/info/exclude`;
  try {
    const path = excludePath(root, git, env);
    if (path === null) {
      return { check, level: "warning", message: "Could not locate .git/info/exclude", fix };
    }
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (!current.split(/\r?\n/).some((line) => line.trim() === LOCAL_CONFIG_PATH)) {
      mkdirSync(dirname(path), { recursive: true });
      const separator = current === "" || current.endsWith("\n") ? "" : "\n";
      appendFileSync(path, `${separator}${LOCAL_CONFIG_PATH}\n`);
    }
    return { check, level: "ok", message: `${LOCAL_CONFIG_PATH} is listed in .git/info/exclude`, fix: "" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { check, level: "warning", message: `Could not update .git/info/exclude: ${reason}`, fix };
  }
}

export function runDoctor(cwd: string, env: Env): DoctorReport {
  const findings: Finding[] = [];
  const tools = toolFindings(env);
  findings.push(...tools.findings);

  const root = findRepository(cwd);
  const gh = tools.paths.get("gh");
  if (gh !== undefined) findings.push(ghAuthFinding(gh, root ?? cwd, env));

  if (root === null) {
    findings.push({
      check: "repository",
      level: "error",
      message: `${resolve(cwd)} is not inside a Git repository`,
      fix: "Run gdt from inside a Git checkout of the target repository",
    });
    return { ok: false, repository: null, config: { valid: false, files: [] }, findings };
  }

  const { report, findings: configFindings } = loadConfig(root, env);
  if (existsSync(join(root, CONFIG_PATH)) || existsSync(join(root, LOCAL_CONFIG_PATH))) {
    findings.push(excludeFinding(root, tools.paths.get("git"), env));
  }
  findings.push(...configFindings);

  return { ok: !hasErrors(findings), repository: root, config: report, findings };
}
