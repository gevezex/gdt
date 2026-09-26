import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Role, ROLES } from "../config.js";
import { which } from "../doctor.js";
import { alive, writeJsonAtomic } from "../state.js";
import type { Backend } from "./backend.js";

type Env = Record<string, string | undefined>;

/** The pane names this backend manages, in creation order. */
const PANE_NAMES = ["supervisor", ...ROLES] as const;
type PaneName = (typeof PANE_NAMES)[number];

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
  /** Role agent names, used in the pane titles. */
  agents: Record<Role, string>;
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

function paneIds(opts: HerdrOptions, workspaceId: string): string[] {
  const result = resultOf(call(["pane", "list", "--workspace", workspaceId], opts), "pane list");
  const list = result.panes;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p) => (isRecord(p) && typeof p.pane_id === "string" ? [p.pane_id] : []));
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

function splitPane(opts: HerdrOptions, anchor: string): string {
  const result = resultOf(call(["pane", "split", anchor, "--direction", "right", "--no-focus"], opts), "pane split");
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

      const live = new Set(paneIds(opts, workspaceId));
      const mapping: PaneState["panes"] = {};
      for (const name of PANE_NAMES) {
        const record = known?.workspace_id === workspaceId ? known.panes[name] : undefined;
        if (record !== undefined && live.has(record.pane_id)) mapping[name] = record;
      }

      // Adopt panes that a previous run left behind (for example after its panes.json was removed).
      const claimed = new Set(Object.values(mapping).flatMap((p) => (p === undefined ? [] : [p.pane_id])));
      const free = [...live].filter((id) => !claimed.has(id));
      for (const name of PANE_NAMES) {
        if (mapping[name] === undefined) {
          const reuse = free.shift();
          if (reuse !== undefined) mapping[name] = { pane_id: reuse };
        }
      }

      const anchor = Object.values(mapping).flatMap((p) => (p === undefined ? [] : [p.pane_id])).find((id) => id !== "");
      for (const name of PANE_NAMES) {
        if (mapping[name] !== undefined) continue;
        if (anchor === undefined) throw new Error(`herdr workspace ${workspaceId} has no pane to split`);
        mapping[name] = { pane_id: splitPane(opts, anchor) };
      }

      writePanes(opts.panesFile, { workspace_id: workspaceId, panes: mapping });
      rename("supervisor", roleTitle("supervisor", "", "starting"));
      for (const role of ROLES) rename(role, roleTitle(role, opts.agents[role], "WAITING"));
    },

    spawnPane(name, argv) {
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

    setTitle: (name, title) => rename(name as PaneName, title),
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
