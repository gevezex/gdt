#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, DEFAULT_LANGUAGE, DEFAULT_MAX_ACCEPTANCE_CRITERIA, loadConfig, ROLES, type Role } from "./config.js";
import { validateContract } from "./contract.js";
import { findRepository, herdrPreflight, runDoctor } from "./doctor.js";
import type { Finding } from "./finding.js";
import { detectedChecks, issueBody } from "./github.js";
import { createRoleRulesFiles, parseRoleSpec, type Proposal, proposal, type RoleSpec, serializeConfig, writeConfig } from "./init.js";
import { loadLocale, shippedLanguages } from "./locale.js";
import { allowRound, answer, installSkill, pause, resume, setAgent, steer } from "./steering.js";
import { supervise } from "./supervisor.js";
import { work } from "./worker.js";
import { type CommandResult, retry, start, status, stop, wait } from "./workflow.js";

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
  init          Create .gdt/config.toml and install the operator skill
  doctor        Check tools, GitHub authentication and .gdt/config.toml
  check-issue   Validate an issue body against the issue contract
  start         Start the workflow for an issue in the background
  status        Show the workflow status and the next step
  wait          Wait until the workflow needs attention
  stop          Stop the workflow for an issue; start resumes it
  retry         Prepare a controlled retry of the failed turn
  answer        Answer an open question
  steer         Send a directive to one role
  pause         Stop dispatching new turns
  resume        Continue dispatching after pause
  allow-round   Grant one extra correction round
  set-agent     Override the agent and model of one role
  install-skill Install the operator skill into detected agent harnesses

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

const INIT_HELP = `Usage: gdt init [--json]
       gdt init --developer <agent>/<model> --tester <agent>/<model> --reviewer <agent>/<model>
                [--language <lang>] [--terminal <herdr|headless>]
                [--required-check <name>]... [--allow-no-required-checks] [--force]

Without the three role options, reports the supported agents, whether each is on
PATH, the usable terminal, the detected CI checks and the language, and writes
nothing. With them, writes .gdt/config.toml, runs "gdt doctor" and installs the
operator skill.

Options:
  --developer <agent>/<model>    Agent and model for the developer role
  --tester <agent>/<model>       Agent and model for the tester role
  --reviewer <agent>/<model>     Agent and model for the reviewer role
  --language <lang>              Language for human-facing text (default en)
  --terminal <herdr|headless>    Terminal backend (default: herdr when usable)
  --required-check <name>        CI check that must pass; repeatable
  --allow-no-required-checks     Accept an empty required_checks list
  --force                        Replace an existing .gdt/config.toml
  --json                         Machine-readable proposal output
`;

const CHECK_ISSUE_HELP = `Usage: gdt check-issue <issue> [--json]
       gdt check-issue --body-file <file> [--json]

Validates an issue body against the issue contract for the configured language
(language in .gdt/config.toml, default en). With <issue>, the body is fetched
with "gh issue view"; with --body-file, a local file is read and GitHub is not
called. Exits with 1 when the contract is invalid.
`;

const WORKFLOW_HELP: Record<string, string> = {
  start: `Usage: gdt start <issue>

Checks the working tree and the issue contract, starts the supervisor and the
role workers as detached processes and returns. Logs: .git/gdt/issue-<n>/logs.
`,
  status: `Usage: gdt status <issue> [--json]

Shows the workflow status and the next step.
`,
  wait: `Usage: gdt wait <issue> [--timeout <seconds>] [--json]

Blocks on the local workflow state and returns with the "gdt status" output as
soon as the workflow needs attention (an action status) or the supervisor is
gone. It returns at once when the workflow is already in an action status.
--timeout gives up after the given number of seconds and exits 1. Reads only
local state under .git/gdt/.
`,
  stop: `Usage: gdt stop <issue>

Stops the supervisor, the role workers and any running agent turn.
"gdt start <issue>" resumes the same workflow.
`,
  retry: `Usage: gdt retry <issue>

Stops the failed or interrupted workflow and clears that turn so
"gdt start <issue>" runs it again.
`,
  pause: `Usage: gdt pause <issue>

Stops dispatching new turns; "gdt resume <issue>" continues.
`,
  resume: `Usage: gdt resume <issue>

Continues dispatching after "gdt pause <issue>".
`,
  "allow-round": `Usage: gdt allow-round <issue>

Grants one extra correction round when the round budget is exhausted.
`,
};

const STEERING_HELP: Record<string, string> = {
  answer: `Usage: gdt answer <issue> <question-id> <text>

Posts a [gdt-answer:v1] comment for an open question. Exits 1 when the
question is unknown or already answered.
`,
  steer: `Usage: gdt steer <issue> --role <role> <text>

Posts a [gdt-directive:v1] comment for one role on the workflow pull request,
or on the issue before a pull request exists. An unknown role exits 1.
`,
  "set-agent": `Usage: gdt set-agent <issue> <role> <agent>/<model>

Overrides the configured agent and model for one role from its next turn;
"gdt status --json" shows the override. An unsupported agent exits 1.
`,
  "install-skill": `Usage: gdt install-skill

Copies skill/SKILL.md into the skill directory of every detected agent
harness and lists the paths. Running it again reports "up to date".
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

function formatProposal(facts: Proposal): string {
  const lines = ["agents:"];
  for (const choice of facts.agents) {
    lines.push(`  ${choice.agent}  ${choice.found ? "found" : "not found"}  model: ${choice.model_format}, example: ${choice.example}`);
  }
  lines.push(
    `terminal: ${facts.terminal}`,
    `required_checks: ${facts.required_checks.length === 0 ? "none" : facts.required_checks.join(", ")}`,
    `language: ${facts.language}`,
    "",
    "Next: gdt init --developer <agent>/<model> --tester <agent>/<model> --reviewer <agent>/<model>",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * `gdt init`: without role options, reports the proposal (AC-1); with all three, writes
 * `.gdt/config.toml` (AC-2 to AC-5), then runs doctor and installs the skill (AC-6, AC-7).
 */
function initCommand(args: readonly string[], io: Io): number {
  let developer: string | undefined;
  let tester: string | undefined;
  let reviewer: string | undefined;
  let language: string | undefined;
  let terminal: "herdr" | "headless" | undefined;
  const requiredChecks: string[] = [];
  let allowNoRequiredChecks = false;
  let force = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--json") json = true;
    else if (arg === "--force") force = true;
    else if (arg === "--allow-no-required-checks") allowNoRequiredChecks = true;
    else if (arg === "--help" || arg === "-h") {
      io.stdout(INIT_HELP);
      return EXIT_OK;
    } else if (arg === "--developer" || arg === "--tester" || arg === "--reviewer" || arg === "--language" || arg === "--terminal" || arg === "--required-check") {
      const given = args[++i];
      if (given === undefined) return usageError(io, `Missing value for "${arg}".`, "gdt init --help");
      if (arg === "--developer") developer = given;
      else if (arg === "--tester") tester = given;
      else if (arg === "--reviewer") reviewer = given;
      else if (arg === "--language") language = given;
      else if (arg === "--terminal") {
        if (given !== "herdr" && given !== "headless") {
          return usageError(io, `Invalid terminal "${given}"; use herdr or headless.`, "gdt init --help");
        }
        terminal = given;
      } else requiredChecks.push(given);
    } else if (arg.startsWith("-")) return usageError(io, `Unknown option "${arg}" for "gdt init".`, "gdt init --help");
    else return usageError(io, `Unexpected argument "${arg}" for "gdt init".`, "gdt init --help");
  }

  const root = findRepository(io.cwd);
  if (root === null) {
    io.stderr(`${io.cwd} is not inside a Git repository. Run gdt from a checkout of the target repository.\n`);
    return EXIT_FAILED;
  }

  const specs: Record<Role, string | undefined> = { developer, tester, reviewer };
  const given = ROLES.filter((role) => specs[role] !== undefined);
  if (given.length === 0) {
    const facts = proposal(root, io.env);
    io.stdout(json ? `${JSON.stringify(facts, null, 2)}\n` : formatProposal(facts));
    return EXIT_OK;
  }
  if (given.length < ROLES.length) {
    const missing = ROLES.filter((role) => specs[role] === undefined)
      .map((role) => `"--${role}"`)
      .join(", ");
    return usageError(io, `Missing ${missing} for "gdt init".`, "gdt init --help");
  }

  const roles = {} as Record<Role, RoleSpec>;
  for (const role of ROLES) {
    const parsed = parseRoleSpec(specs[role] ?? "");
    if ("error" in parsed) {
      io.stderr(`${parsed.error}\n`);
      return EXIT_FAILED;
    }
    roles[role] = parsed;
  }

  const languages = shippedLanguages();
  if (language !== undefined && !languages.includes(language)) {
    io.stderr(`No locale for language "${language}"; available languages: ${languages.join(", ")}\n`);
    return EXIT_FAILED;
  }

  if (existsSync(join(root, CONFIG_PATH)) && !force) {
    io.stderr(`${CONFIG_PATH} already exists; use --force to replace it\n`);
    return EXIT_FAILED;
  }

  const resolvedTerminal = terminal ?? (herdrPreflight(io.env) === null ? "herdr" : "headless");
  const checks = requiredChecks.length > 0 ? requiredChecks : detectedChecks(root, io.env);
  if (checks.length === 0 && !allowNoRequiredChecks) {
    io.stderr(
      "No required checks detected; pass --required-check <name> for each check, or --allow-no-required-checks to accept none\n",
    );
    return EXIT_FAILED;
  }

  const text = serializeConfig({
    roles,
    language: language ?? DEFAULT_LANGUAGE,
    terminal: resolvedTerminal,
    requiredChecks: checks,
    allowNoRequiredChecks,
  });
  const writeError = writeConfig(root, text);
  if (writeError !== null) {
    io.stderr(`${writeError}\n`);
    return EXIT_FAILED;
  }

  // AC-4: the three supplementary role rules files; existing files are left unchanged.
  for (const path of createRoleRulesFiles(root)) io.stdout(`created ${path}\n`);

  // AC-7: report the new config with doctor, then install the skill; the config stays in place either way.
  const report = runDoctor(root, io.env);
  io.stdout(formatFindings(report.findings));
  const installed = installSkill(io.env);
  io.stdout(installed.stdout);
  if (installed.stderr !== "") io.stderr(installed.stderr);
  return report.ok ? EXIT_OK : EXIT_FAILED;
}

function checkIssue(args: readonly string[], io: Io): number {
  let json = false;
  let issue: number | undefined;
  let bodyFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      io.stdout(CHECK_ISSUE_HELP);
      return EXIT_OK;
    } else if (arg === "--body-file") {
      bodyFile = args[++i];
      if (bodyFile === undefined) return usageError(io, 'Missing file for "--body-file".', "gdt check-issue --help");
    } else if (arg.startsWith("-")) {
      return usageError(io, `Unknown option "${arg}" for "gdt check-issue".`, "gdt check-issue --help");
    } else if (issue === undefined && /^[1-9]\d*$/.test(arg)) issue = Number(arg);
    else return usageError(io, `Unexpected argument "${arg}" for "gdt check-issue".`, "gdt check-issue --help");
  }
  if (issue !== undefined && bodyFile !== undefined) {
    return usageError(io, 'Give either an issue number or --body-file to "gdt check-issue", not both.', "gdt check-issue --help");
  }
  if (issue === undefined && bodyFile === undefined) {
    return usageError(io, 'Missing issue number for "gdt check-issue".', "gdt check-issue --help");
  }

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

  let body: string;
  if (bodyFile !== undefined) {
    try {
      body = readFileSync(resolve(io.cwd, bodyFile), "utf8");
    } catch (err) {
      io.stderr(`Cannot read ${bodyFile}: ${err instanceof Error ? err.message : String(err)}\n`);
      return EXIT_FAILED;
    }
  } else {
    const fetched = issueBody(issue ?? 0, root, io.env);
    if ("error" in fetched) {
      io.stderr(`${fetched.error}\n`);
      return EXIT_FAILED;
    }
    body = fetched.body;
  }
  const label = bodyFile ?? `Issue #${issue}`;

  const result = validateContract(body, locale, { maxAcceptanceCriteria });
  if (json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.valid) {
    io.stdout(`${label}: contract valid (${result.acceptance_criteria.length} acceptance criteria)\n`);
  } else {
    const lines = result.errors.map((error) => `  - ${error}`);
    io.stdout(`${label}: contract invalid (${result.errors.length} error(s))\n${lines.join("\n")}\n`);
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

/** Writes a command result to the matching streams and returns its exit code. */
function emit(result: CommandResult, io: Io): number {
  if (result.stdout !== "") io.stdout(result.stdout);
  if (result.stderr !== "") io.stderr(result.stderr);
  return result.code;
}

type WorkflowCommandName = "start" | "status" | "stop" | "retry" | "pause" | "resume" | "allow-round";

function workflowCommand(command: WorkflowCommandName, args: readonly string[], io: Io): number {
  const parsed = issueArgs(command, args, io, command === "status");
  if (typeof parsed === "number") return parsed;
  const { issue, json } = parsed;
  const result =
    command === "start"
      ? start(issue, io.cwd, io.env)
      : command === "stop"
        ? stop(issue, io.cwd, io.env)
        : command === "retry"
          ? retry(issue, io.cwd, io.env)
          : command === "pause"
            ? pause(issue, io.cwd, io.env)
            : command === "resume"
              ? resume(issue, io.cwd, io.env)
              : command === "allow-round"
                ? allowRound(issue, io.cwd, io.env)
                : status(issue, io.cwd, io.env, json);
  return emit(result, io);
}

/** `gdt wait <issue> [--timeout <seconds>] [--json]`: blocks until the workflow needs attention. */
function waitCommand(args: readonly string[], io: Io): number {
  let json = false;
  let timeoutSeconds: number | null = null;
  let issue: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      io.stdout(WORKFLOW_HELP.wait ?? HELP);
      return EXIT_OK;
    } else if (arg === "--timeout") {
      const value = args[++i];
      const seconds = value === undefined ? Number.NaN : Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return usageError(io, `Expected a positive number of seconds after "--timeout", got "${value ?? ""}".`, "gdt wait --help");
      }
      timeoutSeconds = seconds;
    } else if (arg.startsWith("-")) {
      return usageError(io, `Unknown option "${arg}" for "gdt wait".`, "gdt wait --help");
    } else if (issue === undefined && /^[1-9]\d*$/.test(arg)) issue = Number(arg);
    else return usageError(io, `Unexpected argument "${arg}" for "gdt wait".`, "gdt wait --help");
  }
  if (issue === undefined) return usageError(io, 'Missing issue number for "gdt wait".', "gdt wait --help");
  return emit(wait(issue, io.cwd, io.env, { json, timeoutSeconds }), io);
}

/** `gdt answer <issue> <question-id> <text>`; everything after the id is the answer text. */
function answerCommand(args: readonly string[], io: Io): number {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(STEERING_HELP.answer ?? HELP);
    return EXIT_OK;
  }
  const [issueArg, questionId, ...rest] = args;
  if (issueArg === undefined || questionId === undefined || rest.length === 0) {
    return usageError(io, 'Usage: gdt answer <issue> <question-id> <text>.', "gdt answer --help");
  }
  if (!/^[1-9]\d*$/.test(issueArg)) return usageError(io, `Expected an issue number, got "${issueArg}".`, "gdt answer --help");
  return emit(answer(Number(issueArg), questionId, rest.join(" "), io.cwd, io.env), io);
}

/** `gdt steer <issue> --role <role> <text>`. */
function steerCommand(args: readonly string[], io: Io): number {
  let issue: number | undefined;
  let role: string | undefined;
  const text: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      io.stdout(STEERING_HELP.steer ?? HELP);
      return EXIT_OK;
    } else if (arg === "--role") {
      role = args[++i];
      if (role === undefined) return usageError(io, 'Missing value for "--role".', "gdt steer --help");
    } else if (arg.startsWith("-") && !/^-\d/.test(arg)) {
      return usageError(io, `Unknown option "${arg}" for "gdt steer".`, "gdt steer --help");
    } else if (issue === undefined && /^[1-9]\d*$/.test(arg)) {
      issue = Number(arg);
    } else {
      text.push(arg);
    }
  }
  if (issue === undefined) return usageError(io, 'Missing issue number for "gdt steer".', "gdt steer --help");
  if (role === undefined) return usageError(io, 'Missing "--role <role>" for "gdt steer".', "gdt steer --help");
  return emit(steer(issue, role, text.join(" "), io.cwd, io.env), io);
}

/** `gdt set-agent <issue> <role> <agent>/<model>`. */
function setAgentCommand(args: readonly string[], io: Io): number {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(STEERING_HELP["set-agent"] ?? HELP);
    return EXIT_OK;
  }
  const [issueArg, role, spec, ...extra] = args;
  if (issueArg === undefined || role === undefined || spec === undefined || extra.length > 0) {
    return usageError(io, "Usage: gdt set-agent <issue> <role> <agent>/<model>.", "gdt set-agent --help");
  }
  if (!/^[1-9]\d*$/.test(issueArg)) return usageError(io, `Expected an issue number, got "${issueArg}".`, "gdt set-agent --help");
  return emit(setAgent(Number(issueArg), role, spec, io.cwd, io.env), io);
}

/** `gdt install-skill`. */
function installSkillCommand(args: readonly string[], io: Io): number {
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      io.stdout(STEERING_HELP["install-skill"] ?? HELP);
      return EXIT_OK;
    }
    return usageError(io, `Unexpected argument "${arg}" for "gdt install-skill".`, "gdt install-skill --help");
  }
  return emit(installSkill(io.env), io);
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
    case "init":
      return initCommand(rest, io);
    case "check-issue":
      return checkIssue(rest, io);
    case "start":
    case "status":
    case "stop":
    case "retry":
    case "pause":
    case "resume":
    case "allow-round":
      return workflowCommand(command, rest, io);
    case "wait":
      return waitCommand(rest, io);
    case "answer":
      return answerCommand(rest, io);
    case "steer":
      return steerCommand(rest, io);
    case "set-agent":
      return setAgentCommand(rest, io);
    case "install-skill":
      return installSkillCommand(rest, io);
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
