import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { which } from "../src/doctor.js";
import type { State } from "../src/state.js";
import { fakeHerdr, tempRepo } from "./helpers.js";

export const CLI = resolve("dist/cli.js");
export const FAKE_GH = resolve("test/fixtures/fake-gh.mjs");
export const GIT = which("git", process.env) as string;
export const HEAD = "b".repeat(40);

export const BODY = `## Plain language

Text.

## Goal

A goal.

## Context

- Context.

## Definitions

None needed.

## Acceptance criteria

**AC-1: One**

- Given: a
- When: b
- Then: c
- Example: d

**AC-2: Two**

- Given: a
- When: b
- Then: c
- Example: d

## Non-functional

- Fast.

## Out of scope

- Other.

## Assumptions

- One.

## Open questions

None.

## Changelog

- 2026-09-26: Initial.

## Readiness

- [x] Done.
`;

export interface World {
  root: string;
  bin: string;
  github: string;
  env: Record<string, string>;
}

export const worlds: World[] = [];

export interface Options {
  developer?: string;
  tester?: string;
  handoffChecks?: number;
  pr?: boolean;
  notifier?: boolean;
  terminal?: "headless" | "herdr";
  /** `workflow.supervisor_pane`; omitted when undefined, so the gdt default applies. */
  supervisorPane?: boolean;
  /** `workflow.herdr_layout`; omitted when undefined, so the gdt default (`tabs`) applies. */
  herdrLayout?: "split" | "tabs";
  /** Per-role agent names for the config; roles without one use the `fake` test agent. */
  roleAgents?: Partial<Record<"developer" | "tester" | "reviewer", string>>;
  /** Makes the fake herdr's `pane report-agent` exit non-zero (AC-6). */
  reportFail?: boolean;
  extraFiles?: Record<string, string>;
}

export function config(
  handoffChecks: number,
  terminal: "headless" | "herdr" = "headless",
  supervisorPane?: boolean,
  herdrLayout?: "split" | "tabs",
  roleAgents?: Partial<Record<"developer" | "tester" | "reviewer", string>>,
): string {
  const role = (name: "developer" | "tester" | "reviewer") => {
    const agent = roleAgents?.[name] ?? "fake";
    const lines = [`[roles.${name}]`, `agent = "${agent}"`, `model = "none"`];
    if (agent === "fake") lines.push(`script = "scripts/${name}.sh"`);
    return `${lines.join("\n")}\n`;
  };
  return [
    'language = "en"',
    "",
    role("developer"),
    role("tester"),
    role("reviewer"),
    "[workflow]",
    'required_checks = ["ci"]',
    `terminal = "${terminal}"`,
    ...(supervisorPane === undefined ? [] : [`supervisor_pane = ${supervisorPane}`]),
    ...(herdrLayout === undefined ? [] : [`herdr_layout = "${herdrLayout}"`]),
    "poll_seconds = 0.1",
    `handoff_checks = ${handoffChecks}`,
    "",
  ].join("\n");
}

export function world(options: Options = {}): World {
  const root = tempRepo({
    ".gdt/config.toml": config(
      options.handoffChecks ?? 5,
      options.terminal ?? "headless",
      options.supervisorPane,
      options.herdrLayout,
      options.roleAgents,
    ),
    "scripts/developer.sh": options.developer ?? "exit 0\n",
    "scripts/tester.sh": options.tester ?? "/bin/sleep 60\n",
    "scripts/reviewer.sh": "/bin/sleep 60\n",
    ...options.extraFiles,
  });
  const git = (...args: string[]) => spawnSync(GIT, ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root });
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  const bin = mkdtempSync(join(tmpdir(), "gdt-bin-"));
  symlinkSync(GIT, join(bin, "git"));
  fakeHerdr(bin);
  const github = join(bin, "github.json");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "${github}" "$@"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  if (options.notifier ?? true) {
    writeFileSync(join(bin, "terminal-notifier"), `#!/bin/sh\necho "$@" >> "${join(bin, "notifications")}"\n`);
    chmodSync(join(bin, "terminal-notifier"), 0o755);
  }
  writeFileSync(
    github,
    JSON.stringify({
      repo: "gevezex/demo",
      login: "gevezex",
      acceptance_criteria: ["AC-1", "AC-2"],
      issues: { "12": { body: BODY, closed_by: options.pr ? [40] : [] } },
      pulls: { "40": { head: HEAD } },
      comments: {},
    }),
  );
  const env: Record<string, string> = { PATH: bin, HOME: root, GDT_TEST_AGENTS: "1" };
  if (options.reportFail ?? false) env.FAKE_HERDR_REPORT_FAIL = "1";
  const w = { root, bin, github, env };
  worlds.push(w);
  return w;
}

export function gdt(w: World, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: w.root, env: w.env, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function stateOf(w: World): State {
  return JSON.parse(readFileSync(join(w.root, ".git/gdt/issue-12/state.json"), "utf8")) as State;
}

export function lockPid(w: World): number | null {
  const lock = join(w.root, ".git/gdt/issue-12/supervisor.lock");
  return existsSync(lock) ? Number(readFileSync(lock, "utf8")) : null;
}

export function supervisorLog(w: World): string {
  return readFileSync(join(w.root, ".git/gdt/issue-12/logs/supervisor.log"), "utf8");
}

export function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l !== "") : [];
}

export async function waitFor(what: string, condition: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** Changes the fake GitHub state under the same lock the fake gh uses. */
export interface FakeComment {
  id: number;
  author: string;
  created_at: string;
  body: string;
}

export interface GithubData {
  issues: Record<string, { body: string; closed_by?: number[] }>;
  comments: Record<string, FakeComment[]>;
  pulls?: Record<string, { head: string; mergeable?: string; checks?: unknown[] }>;
  next_id?: number;
}

export async function editGithub(w: World, change: (data: GithubData) => void): Promise<void> {
  const lock = `${w.github}.lock`;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 5));
    }
  }
  try {
    const data = JSON.parse(readFileSync(w.github, "utf8")) as GithubData;
    change(data);
    writeFileSync(w.github, JSON.stringify(data));
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  tab_id?: string;
  label: string;
  pid: number | null;
  /** Left edge and width as fractions of the tab width. */
  x: number;
  width: number;
  /** Set by `pane report-agent`; `unknown` until gdt reports a state. */
  agent_status?: string;
  agent?: string;
  agent_source?: string;
  /** Set by `pane report-metadata --display-agent` (AC-1). */
  display_agent?: string;
}

export interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  label: string;
  number?: number;
  pane_count?: number;
}

interface HerdrState {
  workspaces: Record<string, { workspace_id: string; label: string; cwd: string }>;
  tabs: Record<string, HerdrTab>;
  panes: Record<string, HerdrPane>;
}

/** The fake herdr's state file. */
export function herdrState(w: World): HerdrState {
  return JSON.parse(readFileSync(join(w.bin, "herdr.json"), "utf8")) as HerdrState;
}

export function herdrWorkspaces(w: World): HerdrState["workspaces"] {
  return herdrState(w).workspaces;
}

export function herdrPanes(w: World): HerdrPane[] {
  return Object.values(herdrState(w).panes);
}

/** The workspace's tabs, in the fake herdr's order, with their pane count. */
export function herdrTabs(w: World): HerdrTab[] {
  const state = herdrState(w);
  return Object.values(state.tabs).map((tab) => ({
    ...tab,
    pane_count: Object.values(state.panes).filter((pane) => pane.tab_id === tab.tab_id).length,
  }));
}

/** The label of the tab that holds the named pane, or "" when the pane is unknown. */
export function herdrTabOf(w: World, name: string): string {
  const paneId = herdrPaneIds(w)[name];
  const pane = paneId === undefined ? undefined : herdrState(w).panes[paneId];
  return pane?.tab_id === undefined ? "" : (herdrState(w).tabs[pane.tab_id]?.label ?? "");
}

/** The display-only agent label gdt last set for the named pane. */
export function herdrDisplayAgent(w: World, name: string): string {
  const paneId = herdrPaneIds(w)[name];
  return paneId === undefined ? "" : (herdrState(w).panes[paneId]?.display_agent ?? "");
}

/** Pane ids by the name gdt gave them, from `.git/gdt/issue-12/panes.json`. */
export function herdrPaneIds(w: World): Record<string, string> {
  const file = join(w.root, ".git/gdt/issue-12/panes.json");
  const data = JSON.parse(readFileSync(file, "utf8")) as { panes: Record<string, { pane_id: string }> };
  return Object.fromEntries(Object.entries(data.panes).map(([name, pane]) => [name, pane.pane_id]));
}

export function herdrTitle(w: World, name: string): string {
  const paneId = herdrPaneIds(w)[name];
  return paneId === undefined ? "" : (herdrState(w).panes[paneId]?.label ?? "");
}

/** The agent state gdt last reported for the named pane. */
export function herdrAgentStatus(w: World, name: string): string {
  const paneId = herdrPaneIds(w)[name];
  return paneId === undefined ? "" : (herdrState(w).panes[paneId]?.agent_status ?? "");
}

/** The panes of the fake herdr tab from left to right, with their width as a fraction of the tab. */
export function herdrLayout(w: World): { pane_id: string; width: number }[] {
  return Object.values(herdrState(w).panes)
    .sort((a, b) => a.x - b.x)
    .map((pane) => ({ pane_id: pane.pane_id, width: pane.width }));
}

/** Every `pane rename` in order, for asserting a title transition. */
export function herdrTitles(w: World): { pane_id: string; label: string }[] {
  return lines(join(w.bin, "herdr-titles.jsonl")).map((line) => JSON.parse(line) as { pane_id: string; label: string });
}

/** Every herdr invocation's arguments, in order. */
export function herdrCalls(w: World): string[][] {
  return lines(join(w.bin, "herdr-calls.jsonl")).map((line) => JSON.parse(line) as string[]);
}

export function herdrPaneLog(w: World, name: string): string {
  const paneId = herdrPaneIds(w)[name];
  if (paneId === undefined) return "";
  const file = join(w.bin, "herdr-panes", `${paneId.replace(":", "-")}.log`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Stops every workflow started in this test. */
export function stopWorlds(): void {
  for (const w of worlds.splice(0)) if (existsSync(join(w.root, ".git/gdt/issue-12/state.json"))) gdt(w, "stop", "12");
}
