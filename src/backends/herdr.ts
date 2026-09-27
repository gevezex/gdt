import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type HerdrLayout, type Role, ROLES } from "../config.js";
import { which } from "../doctor.js";
import { alive, writeJsonAtomic } from "../state.js";
import type { AgentState, Backend } from "./backend.js";

type Env = Record<string, string | undefined>;

/** One pane name per visible pane; `supervisor` is present only when `workflow.supervisor_pane` is true. */
type PaneName = "supervisor" | Role;

/** The pane names this backend manages, in creation order (AC-2: without a supervisor pane, only roles). */
function paneNames(opts: HerdrOptions): readonly PaneName[] {
  return opts.supervisorPane ? ["supervisor", ...ROLES] : [...ROLES];
}

/** `.git/gdt/issue-<n>/panes.json`: the workspace and the pane id per name. */
interface PaneState {
  workspace_id: string;
  panes: Partial<Record<PaneName, { pane_id: string; pid?: number }>>;
}

export interface HerdrOptions {
  root: string;
  issue: number;
  env: Env;
  /** Path of `panes.json`. */
  panesFile: string;
  /** Directory that holds one pid file per pane. */
  pidDir: string;
  /** Directory that holds `supervisor.log` when the supervisor runs without a pane (AC-3). */
  logs: string;
  /** Role agent names, used in the pane titles. */
  agents: Record<Role, string>;
  /** AC-1: when false, no supervisor pane is created; the supervisor runs detached to its log. */
  supervisorPane: boolean;
  /** AC-3/AC-4: `split` (default) keeps every pane in one tab; `tabs` gives each pane its own tab. */
  layout: HerdrLayout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function bin(env: Env): string {
  const path = which("herdr", env);
  if (path === null) throw new Error("herdr: not found on PATH");
  return path;
}

/** Runs one herdr command and returns its raw stdout. Throws on a non-zero exit. */
function call(args: readonly string[], opts: HerdrOptions): string {
  const result = spawnSync(bin(opts.env), args, { cwd: opts.root, env: opts.env, encoding: "utf8" });
  if (result.status !== 0) {
    const reason = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `herdr exited with ${result.status ?? result.signal}`;
    throw new Error(`herdr ${args.slice(0, 2).join(" ")}: ${reason}`);
  }
  return result.stdout ?? "";
}

/** Runs `pane run`, which prints nothing on success. */
function callVoid(args: readonly string[], opts: HerdrOptions): void {
  call(args, opts);
}

/** Runs `pane report-agent`, which prints nothing on success. Throws on a non-zero exit. */
function reportAgent(opts: HerdrOptions, paneId: string, label: string, state: AgentState): void {
  const args = ["pane", "report-agent", "--source", "gdt", "--agent", label, "--state", state, paneId];
  const result = spawnSync(bin(opts.env), args, { cwd: opts.root, env: opts.env, encoding: "utf8" });
  if (result.status !== 0) {
    const reason = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `herdr exited with ${result.status ?? result.signal}`;
    throw new Error(`herdr pane report-agent: ${reason}`);
  }
}

/**
 * AC-1: sets the display-only agent label of a pane. herdr 0.9.1 requires the pane id before the
 * options here (`herdr pane report-metadata <pane> --source gdt --display-agent <label>`); with the
 * options first it exits 2 with `unknown option: gdt`.
 */
function reportDisplayAgent(opts: HerdrOptions, paneId: string, label: string): void {
  const args = ["pane", "report-metadata", paneId, "--source", "gdt", "--display-agent", label];
  const result = spawnSync(bin(opts.env), args, { cwd: opts.root, env: opts.env, encoding: "utf8" });
  if (result.status !== 0) {
    const reason = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `herdr exited with ${result.status ?? result.signal}`;
    throw new Error(`herdr pane report-metadata: ${reason}`);
  }
}

/** Parses the `{ "result": ... }` envelope; a herdr `error` becomes a thrown Error. */
function resultOf(out: string, command: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(out);
  } catch {
    throw new Error(`herdr ${command}: unexpected output`);
  }
  if (!isRecord(data)) throw new Error(`herdr ${command}: unexpected output`);
  if (isRecord(data.error)) throw new Error(`herdr: ${String(data.error.message ?? data.error.code ?? "unknown error")}`);
  if (!isRecord(data.result)) throw new Error(`herdr ${command}: no result`);
  return data.result;
}

function workspaceList(opts: HerdrOptions): { workspace_id: string; label?: string }[] {
  const result = resultOf(call(["workspace", "list"], opts), "workspace list");
  const list = result.workspaces;
  if (!Array.isArray(list)) return [];
  return list.filter((w): w is { workspace_id: string; label?: string } => isRecord(w) && typeof w.workspace_id === "string");
}

interface PaneLocation {
  pane_id: string;
  tab_id?: string;
}

/** `pane list --workspace`, with the tab each pane currently lives in. */
function paneLocations(opts: HerdrOptions, workspaceId: string): PaneLocation[] {
  const result = resultOf(call(["pane", "list", "--workspace", workspaceId], opts), "pane list");
  const list = result.panes;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p) =>
    isRecord(p) && typeof p.pane_id === "string"
      ? [{ pane_id: p.pane_id, ...(typeof p.tab_id === "string" ? { tab_id: p.tab_id } : {}) }]
      : [],
  );
}

interface TabLocation {
  tab_id: string;
  label: string;
  pane_count: number;
}

/** `tab list --workspace`, in herdr's order. */
function tabLocations(opts: HerdrOptions, workspaceId: string): TabLocation[] {
  const result = resultOf(call(["tab", "list", "--workspace", workspaceId], opts), "tab list");
  const list = result.tabs;
  if (!Array.isArray(list)) return [];
  return list.flatMap((tab) =>
    isRecord(tab) && typeof tab.tab_id === "string"
      ? [
          {
            tab_id: tab.tab_id,
            label: typeof tab.label === "string" ? tab.label : "",
            pane_count: typeof tab.pane_count === "number" ? tab.pane_count : 0,
          },
        ]
      : [],
  );
}

/** AC-3: creates a tab labelled with a pane name; its root pane becomes the managed pane. */
function createTab(opts: HerdrOptions, workspaceId: string, label: string): string {
  const args = ["tab", "create", "--workspace", workspaceId, "--cwd", opts.root, "--label", label, "--no-focus"];
  const result = resultOf(call(args, opts), "tab create");
  const pane = result.root_pane;
  if (!isRecord(pane) || typeof pane.pane_id !== "string") throw new Error("herdr tab create did not return a root pane");
  return pane.pane_id;
}

/** AC-5: moves an existing pane into a tab of its own, labelled with the pane name. */
function movePaneToNewTab(opts: HerdrOptions, pane: string, label: string): void {
  call(["pane", "move", pane, "--new-tab", "--label", label, "--no-focus"], opts);
}

/** AC-5: moves an existing pane next to `anchor` in `tab`, keeping `ratio` of the anchor's width. */
function movePaneIntoTab(opts: HerdrOptions, pane: string, tab: string, anchor: string, ratio: number): void {
  const args = ["pane", "move", pane, "--tab", tab, "--split", "right", "--target-pane", anchor, "--ratio", ratio.toFixed(4), "--no-focus"];
  call(args, opts);
}

function renameTab(opts: HerdrOptions, tab: string, label: string): void {
  call(["tab", "rename", tab, label], opts);
}

/** AC-5: a tab that lost its last pane during a move must not remain. */
function closeEmptyTabs(opts: HerdrOptions, workspaceId: string, keep: ReadonlySet<string>): void {
  for (const tab of tabLocations(opts, workspaceId)) {
    if (tab.pane_count === 0 && !keep.has(tab.tab_id)) call(["tab", "close", tab.tab_id], opts);
  }
}

function createWorkspace(opts: HerdrOptions): { workspace_id: string; root_pane: string } {
  const label = `gdt-${opts.issue}`;
  const result = resultOf(call(["workspace", "create", "--cwd", opts.root, "--label", label, "--no-focus"], opts), "workspace create");
  const workspace = result.workspace;
  const rootPane = result.root_pane;
  if (!isRecord(workspace) || typeof workspace.workspace_id !== "string" || !isRecord(rootPane) || typeof rootPane.pane_id !== "string") {
    throw new Error("herdr workspace create did not return a workspace and root pane");
  }
  return { workspace_id: workspace.workspace_id, root_pane: rootPane.pane_id };
}

/** Splits `anchor` to the right; `ratio` is the share of the width that `anchor` keeps. */
function splitPane(opts: HerdrOptions, anchor: string, ratio: number): string {
  const result = resultOf(
    call(["pane", "split", anchor, "--direction", "right", "--ratio", ratio.toFixed(4), "--no-focus"], opts),
    "pane split",
  );
  const pane = result.pane;
  if (!isRecord(pane) || typeof pane.pane_id !== "string") throw new Error("herdr pane split did not return a pane id");
  return pane.pane_id;
}

function readPanes(file: string): PaneState | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PaneState;
  } catch {
    return null;
  }
}

function writePanes(file: string, state: PaneState): void {
  writeJsonAtomic(file, state);
}

function roleTitle(role: PaneName, agent: string, state: string): string {
  return role === "supervisor" ? `supervisor · ${state}` : `${role} · ${agent} · ${state}`;
}

/**
 * AC-4/AC-5: all managed panes in one tab, left to right in `names` order. This is a no-op when the
 * panes already share a tab, so a workspace created in split layout is left exactly as before.
 */
function arrangeSplit(
  opts: HerdrOptions,
  workspaceId: string,
  names: readonly PaneName[],
  mapping: PaneState["panes"],
  paneTab: ReadonlyMap<string, string>,
): void {
  const paneOf = (name: PaneName): string | undefined => mapping[name]?.pane_id;
  const first = names[0];
  if (first === undefined) return;
  const targetPane = paneOf(first);
  if (targetPane === undefined) return;

  const tabs = new Set(names.flatMap((name) => {
    const pane = paneOf(name);
    if (pane === undefined) return [];
    const tab = paneTab.get(pane);
    return tab === undefined ? [] : [tab];
  }));
  if (tabs.size <= 1) return;
  const target = paneTab.get(targetPane);
  if (target === undefined) return;

  let anchor = targetPane;
  names.slice(1).forEach((name, index) => {
    const pane = paneOf(name);
    if (pane === undefined) return;
    if (paneTab.get(pane) !== target) movePaneIntoTab(opts, pane, target, anchor, 1 / (names.length - (index + 1) + 1));
    anchor = pane;
  });
}

/** AC-3/AC-5: one tab per managed pane, labelled with the pane name, in `names` order. */
function arrangeTabs(opts: HerdrOptions, workspaceId: string, names: readonly PaneName[], mapping: PaneState["panes"]): void {
  const tabByPane = new Map<string, string>();
  const countByTab = new Map<string, number>();
  for (const pane of paneLocations(opts, workspaceId)) {
    if (pane.tab_id === undefined) continue;
    tabByPane.set(pane.pane_id, pane.tab_id);
    countByTab.set(pane.tab_id, (countByTab.get(pane.tab_id) ?? 0) + 1);
  }
  const labels = new Map(tabLocations(opts, workspaceId).map((tab) => [tab.tab_id, tab.label]));

  const kept = new Set<string>();
  for (const name of names) {
    const pane = mapping[name]?.pane_id;
    if (pane === undefined) continue;
    const tab = tabByPane.get(pane);
    // Keep a pane that is already alone in a tab of its own; only relabel that tab when needed.
    if (tab !== undefined && !kept.has(tab) && countByTab.get(tab) === 1) {
      kept.add(tab);
      if (labels.get(tab) !== name) renameTab(opts, tab, name);
      continue;
    }
    movePaneToNewTab(opts, pane, name);
  }
  closeEmptyTabs(opts, workspaceId, kept);
}

/**
 * One herdr workspace per issue, with four panes for supervisor, developer, tester and reviewer.
 * Panes are reused across `start` calls; their ids live in `panes.json` so a restarted process can
 * find them. Verified against herdr 0.9.1 in the default session.
 */
export function herdr(opts: HerdrOptions): Backend {
  let warnedMissing = false;

  const findPane = (name: PaneName): string | null => {
    const state = readPanes(opts.panesFile);
    const id = state?.panes[name]?.pane_id;
    return id === undefined || id === "" ? null : id;
  };

  const rename = (name: PaneName, title: string): void => {
    if (warnedMissing) return;
    const paneId = findPane(name);
    if (paneId === null) {
      warnedMissing = true;
      return;
    }
    call(["pane", "rename", paneId, title], opts);
  };

  return {
    ensureWorkspace() {
      mkdirSync(opts.pidDir, { recursive: true });
      const known = readPanes(opts.panesFile);
      const list = workspaceList(opts);

      let workspaceId = known !== null && list.some((w) => w.workspace_id === known.workspace_id) ? known.workspace_id : undefined;
      if (workspaceId === undefined) {
        const existing = list.find((w) => w.label === `gdt-${opts.issue}`);
        if (existing !== undefined) workspaceId = existing.workspace_id;
        else workspaceId = createWorkspace(opts).workspace_id;
      }

      const locations = paneLocations(opts, workspaceId);
      const live = new Set(locations.map((pane) => pane.pane_id));
      const paneTab = new Map<string, string>();
      for (const pane of locations) if (pane.tab_id !== undefined) paneTab.set(pane.pane_id, pane.tab_id);

      // AC-4: a supervisor pane from an earlier run (while `supervisor_pane` was true) is closed; its
      // entry never enters the new panes.json, so no role can adopt the pane.
      if (!opts.supervisorPane && known?.workspace_id === workspaceId) {
        const leftover = known.panes.supervisor;
        if (leftover !== undefined && live.has(leftover.pane_id)) {
          call(["pane", "close", leftover.pane_id], opts);
          live.delete(leftover.pane_id);
          paneTab.delete(leftover.pane_id);
        }
      }

      const names = paneNames(opts);
      const mapping: PaneState["panes"] = {};
      for (const name of names) {
        const record = known?.workspace_id === workspaceId ? known.panes[name] : undefined;
        if (record !== undefined && live.has(record.pane_id)) mapping[name] = record;
      }

      // Adopt panes that a previous run left behind (for example after its panes.json was removed).
      const claimed = new Set(Object.values(mapping).flatMap((p) => (p === undefined ? [] : [p.pane_id])));
      const free = [...live].filter((id) => !claimed.has(id));
      for (const name of names) {
        if (mapping[name] === undefined) {
          const reuse = free.shift();
          if (reuse !== undefined) mapping[name] = { pane_id: reuse };
        }
      }

      // Provide a pane for every name that still lacks one, in `names` order.
      if (opts.layout === "tabs") {
        // AC-3: each missing pane gets its own tab, labelled with the pane name.
        for (const name of names) {
          if (mapping[name] === undefined) mapping[name] = { pane_id: createTab(opts, workspaceId, name) };
        }
      } else {
        // AC-4: each new pane is split off the right of the previous one, so panes run left to right
        // in `names` order. The anchor keeps 1/(panes still to fill), which makes a new workspace's
        // panes equally wide.
        const first = Object.values(mapping).flatMap((p) => (p === undefined ? [] : [p.pane_id])).find((id) => id !== "");
        let previous: string | undefined;
        names.forEach((name, index) => {
          const record = mapping[name];
          if (record !== undefined) {
            previous = record.pane_id;
            return;
          }
          const anchor = previous ?? first;
          if (anchor === undefined) throw new Error(`herdr workspace ${workspaceId} has no pane to split`);
          previous = splitPane(opts, anchor, 1 / (names.length - index + 1));
          mapping[name] = { pane_id: previous };
          const anchorTab = paneTab.get(anchor);
          if (anchorTab !== undefined) paneTab.set(previous, anchorTab);
        });
      }

      // AC-3/AC-5: place the panes according to the configured layout.
      if (opts.layout === "tabs") arrangeTabs(opts, workspaceId, names, mapping);
      else arrangeSplit(opts, workspaceId, names, mapping, paneTab);

      writePanes(opts.panesFile, { workspace_id: workspaceId, panes: mapping });
      if (opts.supervisorPane) rename("supervisor", roleTitle("supervisor", "", "starting"));
      for (const role of ROLES) rename(role, roleTitle(role, opts.agents[role], "WAITING"));
    },

    spawnPane(name, argv) {
      // AC-3: without a supervisor pane the supervisor is a detached process whose output is its log.
      if (name === "supervisor" && !opts.supervisorPane) return spawnDetached(opts, "supervisor", argv);
      const state = readPanes(opts.panesFile);
      const paneId = state?.panes[name as PaneName]?.pane_id;
      if (state === null || paneId === undefined || paneId === "") throw new Error(`herdr: no pane named ${name}`);
      if (argv.length === 0) throw new Error("spawnPane: empty argv");

      mkdirSync(opts.pidDir, { recursive: true });
      const pidFile = join(opts.pidDir, name);
      rmSync(pidFile, { force: true });
      // The wrapper shell writes its pid and then becomes the gdt process, so the pid stays valid
      // while the pane's own shell remains for the next command.
      const inner = `echo $$ > ${shellQuote(pidFile)}; exec ${argv.map(shellQuote).join(" ")}`;
      callVoid(["pane", "run", paneId, `sh -c ${shellQuote(inner)}`], opts);

      const pid = waitForPid(pidFile);
      state.panes[name as PaneName] = { pane_id: paneId, pid };
      writePanes(opts.panesFile, state);
      return pid;
    },

    setTitle(name, title) {
      // AC-6: without a supervisor pane there is no title to set for the supervisor.
      if (name === "supervisor" && !opts.supervisorPane) return;
      rename(name as PaneName, title);
    },

    setDisplayAgent(name, label) {
      // Without a supervisor pane there is no supervisor label to set.
      if (name === "supervisor" && !opts.supervisorPane) return;
      const paneId = findPane(name as PaneName);
      if (paneId === null) return;
      reportDisplayAgent(opts, paneId, label);
    },

    reportState(name, state) {
      // AC-6: without a supervisor pane no supervisor state is reported to herdr.
      if (name === "supervisor" && !opts.supervisorPane) return;
      const paneId = findPane(name as PaneName);
      if (paneId === null) throw new Error(`herdr: no pane named ${name}`);
      // AC-4/AC-5: the role's agent is the label, the supervisor reports as `gdt`.
      const label = name === "supervisor" ? "gdt" : opts.agents[name as Role];
      reportAgent(opts, paneId, label, state);
    },

    alive: (handle) => alive(handle),
    attach: () => {
      const state = readPanes(opts.panesFile);
      // `workspace focus` only switches the server's focused workspace; plain `herdr` attaches the terminal.
      return state === null ? "herdr" : `herdr workspace focus ${state.workspace_id} && herdr (workspace gdt-${opts.issue})`;
    },
    close(handle) {
      try {
        process.kill(handle, "SIGTERM");
      } catch {
        // Already gone.
      }
      for (let waited = 0; waited < 5000 && alive(handle); waited += 50) sleepSync(50);
      if (alive(handle)) {
        try {
          process.kill(handle, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    },
  };
}

/** Starts `argv` detached with stdout and stderr in `logs/<name>.log`, like the headless backend. */
function spawnDetached(opts: HerdrOptions, name: string, argv: readonly string[]): number {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("spawnPane: empty argv");
  mkdirSync(opts.logs, { recursive: true });
  const out = openSync(join(opts.logs, `${name}.log`), "a");
  const child = spawn(command, args, { cwd: opts.root, env: opts.env, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  if (child.pid === undefined) throw new Error(`could not start ${name}`);
  return child.pid;
}

function waitForPid(file: string): number {
  for (let waited = 0; waited < 5000; waited += 50) {
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    sleepSync(50);
  }
  throw new Error(`herdr pane did not report its process id (${file})`);
}
