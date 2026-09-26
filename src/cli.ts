#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runDoctor } from "./doctor.js";
import type { Finding } from "./finding.js";

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

Options:
  --json        Machine-readable output (doctor)
  --help, -h    Show help
  --version     Print the gdt version
`;

const DOCTOR_HELP = `Usage: gdt doctor [--json]

Checks that git and gh are installed, gh is authenticated, and that
.gdt/config.toml (merged with .gdt/config.local.toml) is valid.
Exits with 1 when any finding has level "error".
`;

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
  process.exitCode = run(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
