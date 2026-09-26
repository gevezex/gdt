#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, DEFAULT_LANGUAGE, DEFAULT_MAX_ACCEPTANCE_CRITERIA, loadConfig, ROLES, type Role } from "./config.js";
import { validateContract } from "./contract.js";
import { findRepository, runDoctor } from "./doctor.js";
import type { Finding } from "./finding.js";
import { issueBody } from "./github.js";
import { loadLocale } from "./locale.js";
import { supervise } from "./supervisor.js";
import { work } from "./worker.js";
import { start, status, stop } from "./workflow.js";

export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Exit codes: 0 success, 1 a check failed, 2 usage error. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

const HELP = `gdt - GitHub issues to merge-ready pull requests

Usage:
  gdt <command> [options]

Commands:
  doctor        Check tools, GitHub authentication and .gdt/config.toml
  check-issue   Validate an issue body against the issue contract
  start         Start the workflow for an issue in the background
  status        Show the workflow status and the next step
  stop          Stop the workflow for an issue; start resumes it

Options:
  --json        Machine-readable output
  --help, -h    Show help
  --version     Print the gdt version
`;

const DOCTOR_HELP = `Usage: gdt doctor [--json]

Checks that git and gh are installed, gh is authenticated, and that
.gdt/config.toml (merged with .gdt/config.local.toml) is valid.
Exits with 1 when any finding has level "error".
`;

const CHECK_ISSUE_HELP = `Usage: gdt check-issue <issue> [--json]

Fetches the body of the issue with "gh issue view" and validates it against the
issue contract for the configured language (language in .gdt/config.toml,
default en). Exits with 1 when the contract is invalid.
`;

const WORKFLOW_HELP: Record<string, string> = {
  start: `Usage: gdt start <issue>

Checks the working tree and the issue contract, starts the supervisor and the
role workers as detached processes and returns. Logs: .git/gdt/issue-<n>/logs.
`,
  status: `Usage: gdt status <issue> [--json]

Shows the workflow status and the next step.
`,
  stop: `Usage: gdt stop <issue>

Stops the supervisor, the role workers and any running agent turn.
"gdt start <issue>" resumes the same workflow.
`,
};

export function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

function usageError(io: Io, message: string, help: string): number {
  io.stderr(`${message} Run "${help}".\n`);
  return EXIT_USAGE;
}

const MARKS: Record<Finding["level"], string> = { ok: "ok     ", warning: "warning", error: "error  " };

function formatFindings(findings: readonly Finding[]): string {
  const lines = findings.map((f) => `${MARKS[f.level]}  ${f.message}${f.fix === "" ? "" : `\n         fix: ${f.fix}`}`);
  const errors = findings.filter((f) => f.level === "error").length;
  const warnings = findings.filter((f) => f.level === "warning").length;
  lines.push("", `${errors} error(s), ${warnings} warning(s)`);
  return `${lines.join("\n")}\n`;
}

function doctor(args: readonly string[], io: Io): number {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      io.stdout(DOCTOR_HELP);
      return EXIT_OK;
    } else return usageError(io, `Unknown option "${arg}" for "gdt doctor".`, "gdt doctor --help");
  }

  const report = runDoctor(io.cwd, io.env);
  io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : formatFindings(report.findings));
  return report.ok ? EXIT_OK : EXIT_FAILED;
}

function checkIssue(args: readonly string[], io: Io): number {
  let json = false;
  let issue: number | undefined;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      io.stdout(CHECK_ISSUE_HELP);
      return EXIT_OK;
    } else if (arg.startsWith("-")) {
      return usageError(io, `Unknown option "${arg}" for "gdt check-issue".`, "gdt check-issue --help");
    } else if (issue === undefined && /^[1-9]\d*$/.test(arg)) issue = Number(arg);
    else return usageError(io, `Unexpected argument "${arg}" for "gdt check-issue".`, "gdt check-issue --help");
  }
  if (issue === undefined) return usageError(io, 'Missing issue number for "gdt check-issue".', "gdt check-issue --help");

  const root = findRepository(io.cwd) ?? io.cwd;
  let language = DEFAULT_LANGUAGE;
  let maxAcceptanceCriteria = DEFAULT_MAX_ACCEPTANCE_CRITERIA;
  if (existsSync(join(root, CONFIG_PATH))) {
    const { report } = loadConfig(root, io.env);
    if (!report.valid) {
      io.stderr(`${CONFIG_PATH} is invalid. Run "gdt doctor" for details.\n`);
      return EXIT_FAILED;
    }
    language = report.language;
    maxAcceptanceCriteria = report.contract.max_acceptance_criteria;
  }

  let locale;
  try {
    locale = loadLocale(language);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_FAILED;
  }

  const fetched = issueBody(issue, root, io.env);
  if ("error" in fetched) {
    io.stderr(`${fetched.error}\n`);
    return EXIT_FAILED;
  }

  const result = validateContract(fetched.body, locale, { maxAcceptanceCriteria });
  if (json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.valid) {
    io.stdout(`Issue #${issue}: contract valid (${result.acceptance_criteria.length} acceptance criteria)\n`);
  } else {
    const lines = result.errors.map((error) => `  - ${error}`);
    io.stdout(`Issue #${issue}: contract invalid (${result.errors.length} error(s))\n${lines.join("\n")}\n`);
  }
  return result.valid ? EXIT_OK : EXIT_FAILED;
}

/** Parses `<issue> [--json]` for the workflow commands; returns an exit code on usage errors or help. */
function issueArgs(command: string, args: readonly string[], io: Io, allowJson: boolean): { issue: number; json: boolean } | number {
  let json = false;
  let issue: number | undefined;
  for (const arg of args) {
    if (arg === "--json" && allowJson) json = true;
    else if (arg === "--help" || arg === "-h") {
      io.stdout(WORKFLOW_HELP[command] ?? HELP);
      return EXIT_OK;
    } else if (arg.startsWith("-")) {
      return usageError(io, `Unknown option "${arg}" for "gdt ${command}".`, `gdt ${command} --help`);
    } else if (issue === undefined && /^[1-9]\d*$/.test(arg)) issue = Number(arg);
    else return usageError(io, `Unexpected argument "${arg}" for "gdt ${command}".`, `gdt ${command} --help`);
  }
  if (issue === undefined) return usageError(io, `Missing issue number for "gdt ${command}".`, `gdt ${command} --help`);
  return { issue, json };
}

function workflowCommand(command: "start" | "status" | "stop", args: readonly string[], io: Io): number {
  const parsed = issueArgs(command, args, io, command === "status");
  if (typeof parsed === "number") return parsed;
  const result =
    command === "start"
      ? start(parsed.issue, io.cwd, io.env)
      : command === "stop"
        ? stop(parsed.issue, io.cwd, io.env)
        : status(parsed.issue, io.cwd, io.env, parsed.json);
  if (result.stdout !== "") io.stdout(result.stdout);
  if (result.stderr !== "") io.stderr(result.stderr);
  return result.code;
}

/** Internal entry points started by the terminal backend; not part of the public CLI. */
async function internal(command: string, args: readonly string[], io: Io): Promise<number> {
  const issue = Number(args[0]);
  const root = findRepository(io.cwd) ?? io.cwd;
  if (command === "_supervise") return supervise(root, issue, io.env);
  const role = args[1];
  if (!ROLES.includes(role as Role)) return EXIT_USAGE;
  return work(root, issue, role as Role, io.env);
}

export function run(argv: readonly string[], io: Io): number {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      io.stdout(HELP);
      return EXIT_OK;
    case "--version":
      io.stdout(`${version()}\n`);
      return EXIT_OK;
    case "doctor":
      return doctor(rest, io);
    case "check-issue":
      return checkIssue(rest, io);
    case "start":
    case "status":
    case "stop":
      return workflowCommand(command, rest, io);
    default:
      if (command.startsWith("-")) return usageError(io, `Unknown option "${command}".`, "gdt --help");
      return usageError(io, `Unknown command "${command}".`, "gdt --help");
  }
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const io: Io = {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  const [command, ...rest] = process.argv.slice(2);
  if (command === "_supervise" || command === "_worker") {
    process.exitCode = await internal(command, rest, io);
  } else {
    process.exitCode = run(process.argv.slice(2), io);
  }
}
