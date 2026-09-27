import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import type { DoctorReport } from "../src/doctor.js";
import { fakePath, writeUserConfig } from "./helpers.js";

const REPO_ROOT = process.cwd();
const DOCS = readFileSync("docs/dogfooding.md", "utf8");

/** The agents column every run in this repository used (.gdt/config.toml, roles.*.agent). */
const AGENTS = "opencode / claude / codex";

interface RunRecord {
  issue: number;
  date: string;
  backend: string;
  agents: string;
  rounds: number;
  status: string;
  humanInterventions: string;
  problems: string;
}

/** Parses the run-record table of docs/dogfooding.md. */
function runRecords(): RunRecord[] {
  return DOCS.split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 8 && /^#\d+$/.test(cells[0] ?? ""))
    .map((cells) => ({
      issue: Number((cells[0] ?? "").slice(1)),
      date: cells[1] ?? "",
      backend: cells[2] ?? "",
      agents: cells[3] ?? "",
      rounds: Number(cells[4]),
      status: cells[5] ?? "",
      humanInterventions: cells[6] ?? "",
      problems: cells[7] ?? "",
    }));
}

/** A run record is complete when every documented field is filled with a plausible value. */
function expectComplete(run: RunRecord, backend: string): void {
  expect(run.issue).toBeGreaterThan(0);
  expect(run.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(run.backend).toBe(backend);
  expect(run.agents).toBe(AGENTS);
  expect(run.rounds).toBeGreaterThanOrEqual(0);
  expect(["ready_to_merge", "blocked"]).toContain(run.status);
  expect(run.humanInterventions.length).toBeGreaterThan(0);
  expect(run.problems.length).toBeGreaterThan(0);
}

describe("AC-1: the repository is configured for gdt", () => {
  /** A temporary user config so the test never reads or writes the real home directory. */
  function tempHome(): string {
    const home = mkdtempSync(join(tmpdir(), "gdt-home-"));
    writeUserConfig(home);
    return home;
  }

  it("has language en and required_checks [test] in .gdt/config.toml", () => {
    const { report } = loadConfig(REPO_ROOT, { HOME: tempHome() });
    expect(report.valid).toBe(true);
    if (!report.valid) return;
    expect(report.files).toContain(".gdt/config.toml");
    expect(report.language).toBe("en");
    expect(report.workflow.required_checks).toEqual(["test"]);
    expect(report.roles.developer.source).toContain(join(".config", "gdt", "config.toml"));
  });

  it("doctor reports no error finding", () => {
    let stdout = "";
    run(["doctor", "--json"], {
      cwd: REPO_ROOT,
      env: { PATH: fakePath(), HOME: tempHome() },
      stdout: (text) => (stdout += text),
      stderr: () => {},
    });
    const report = JSON.parse(stdout) as DoctorReport;
    expect(report.config.valid).toBe(true);
    expect(report.findings.filter((finding) => finding.level === "error")).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("AC-2: a headless dogfood run is recorded", () => {
  it("has a complete headless run record", () => {
    const headless = runRecords().filter((run) => run.backend === "headless");
    expect(headless.length).toBeGreaterThan(0);
    for (const run of headless) expectComplete(run, "headless");
  });
});

describe("AC-3: a herdr dogfood run is recorded", () => {
  it("has a complete herdr run record", () => {
    const herdr = runRecords().filter((run) => run.backend === "herdr");
    expect(herdr.length).toBeGreaterThan(0);
    for (const run of herdr) expectComplete(run, "herdr");
  });
});

describe("AC-4: problems become issues", () => {
  it("links every listed problem to an issue in this repository", () => {
    const withProblems = runRecords().filter((run) => run.problems !== "none");
    expect(withProblems.length).toBeGreaterThan(0);
    for (const run of withProblems) {
      const links = [...run.problems.matchAll(/\[#(\d+)\]\((https:\/\/github\.com\/gevezex\/gdt\/issues\/(\d+))\)/g)];
      expect(links.length).toBeGreaterThan(0);
      for (const [, label, url, issue] of links) {
        expect(label).toBe(issue);
        expect(url).toBe(`https://github.com/gevezex/gdt/issues/${issue}`);
      }
    }
  });
});
