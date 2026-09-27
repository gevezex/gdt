// A stand-in for `herdr` (0.9.1 CLI shape), backed by one JSON file in the bin directory given by
// FAKE_HERDR_DIR. `pane run` really starts the command detached with its output appended to a log,
// so herdr-mode gdt runs behave like the headless ones. Each invocation is recorded in
// herdr-calls.jsonl; each `pane rename` is appended to herdr-titles.jsonl.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const dir = process.env.FAKE_HERDR_DIR ?? process.cwd();
const store = join(dir, "herdr.json");
const panesDir = join(dir, "herdr-panes");
const calls = join(dir, "herdr-calls.jsonl");
const titles = join(dir, "herdr-titles.jsonl");
const version = process.env.FAKE_HERDR_VERSION ?? "0.9.1";
const args = process.argv.slice(2);
const command = args[0] ?? "";

function read() {
  try {
    return JSON.parse(readFileSync(store, "utf8"));
  } catch {
    return { workspaces: {}, tabs: {}, panes: {} };
  }
}

function write(data) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${store}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, store);
}

function withLock(fn) {
  const lock = `${store}.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (i > 4000) throw new Error("fake herdr: lock timeout");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    const data = read();
    const result = fn(data);
    write(data);
    return result;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function ok(result) {
  out({ id: `fake:${command}`, result });
}

function fail(code, message) {
  out({ id: `fake:${command}`, error: { code, message } });
  process.exitCode = 1;
}

function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function nextId(prefix, keys) {
  return keys.reduce((max, key) => Math.max(max, Number(/(\d+)$/.exec(key)?.[1] ?? 0)), 0) + 1;
}

function paneIdsIn(state, workspaceId) {
  return Object.values(state.panes)
    .filter((pane) => pane.workspace_id === workspaceId)
    .map((pane) => pane.pane_id);
}

function tabsIn(state, workspaceId) {
  return Object.values(state.tabs).filter((tab) => tab.workspace_id === workspaceId).map((tab) => tab.tab_id);
}

function paneCountIn(state, tabId) {
  return Object.values(state.panes).filter((pane) => pane.tab_id === tabId).length;
}

function tabInfo(state, tabId) {
  const tab = state.tabs[tabId];
  return { tab_id: tab.tab_id, workspace_id: tab.workspace_id, label: tab.label, number: tab.number, pane_count: paneCountIn(state, tabId) };
}

/** Closes a tab (and its panes), like herdr does when its last pane disappears. */
function closeTab(state, tabId) {
  if (state.tabs[tabId] === undefined) return;
  state.tabs = Object.fromEntries(Object.entries(state.tabs).filter(([id]) => id !== tabId));
  state.panes = Object.fromEntries(Object.entries(state.panes).filter(([, pane]) => pane.tab_id !== tabId));
}

/** Closes `tabId` when no pane is left in it; herdr removes an emptied tab after a move. */
function closeTabIfEmpty(state, tabId) {
  if (state.tabs[tabId] !== undefined && paneCountIn(state, tabId) === 0) closeTab(state, tabId);
}

function paneInfo(pane) {
  return {
    pane_id: pane.pane_id,
    workspace_id: pane.workspace_id,
    tab_id: pane.tab_id,
    label: pane.label,
    cwd: pane.cwd,
    agent_status: pane.agent_status ?? "unknown",
    agent: pane.agent,
    agent_source: pane.agent_source,
    display_agent: pane.display_agent,
  };
}

// `pane report-agent` has the pane id as its only positional argument, among flag/value pairs.
const REPORT_AGENT_FLAGS = new Set([
  "--source",
  "--agent",
  "--state",
  "--message",
  "--seq",
  "--agent-session-id",
  "--agent-session-path",
]);

function reportAgentPaneArg(args) {
  let paneArg;
  for (let i = 2; i < args.length; i++) {
    if (REPORT_AGENT_FLAGS.has(args[i])) {
      i += 1;
      continue;
    }
    paneArg = args[i];
  }
  return paneArg;
}

// `pane report-metadata` takes value flags and clear flags, plus the pane id as its positional argument.
const METADATA_VALUE_FLAGS = new Set([
  "--source",
  "--agent",
  "--applies-to-source",
  "--title",
  "--display-agent",
  "--state-label",
  "--token",
  "--seq",
  "--ttl-ms",
]);

function metadataPaneArg(args) {
  for (let i = 2; i < args.length; i++) {
    if (METADATA_VALUE_FLAGS.has(args[i])) {
      i += 1;
      continue;
    }
    if (args[i].startsWith("--")) continue;
    return args[i];
  }
  return undefined;
}

if (command === "--version") {
  process.stdout.write(`herdr ${version}\n`);
  process.exit(0);
}

if (args.length > 0) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(calls, `${JSON.stringify(args)}\n`, { flag: "a" });
}

try {
  withLock((state) => {
    if (command === "workspace" && args[1] === "list") {
      return ok({
        type: "workspace_list",
        workspaces: Object.values(state.workspaces).map((workspace) => ({
          workspace_id: workspace.workspace_id,
          label: workspace.label,
          pane_count: paneIdsIn(state, workspace.workspace_id).length,
        })),
      });
    }

    if (command === "workspace" && args[1] === "get") {
      const workspace = state.workspaces[args[2]];
      if (workspace === undefined) return fail("workspace_not_found", `workspace ${args[2]} not found`);
      return ok({ type: "workspace_info", workspace });
    }

    if (command === "workspace" && args[1] === "create") {
      const n = nextId("w", Object.keys(state.workspaces));
      const workspace_id = `w${n}`;
      const tab_id = `${workspace_id}:t1`;
      const pane_id = `${workspace_id}:p1`;
      const cwd = flag("--cwd") ?? process.cwd();
      state.workspaces[workspace_id] = { workspace_id, label: flag("--label") ?? String(n), cwd };
      state.tabs[tab_id] = { tab_id, workspace_id, label: "1", number: 1 };
      state.panes[pane_id] = { pane_id, workspace_id, tab_id, label: "", cwd, pid: null, x: 0, width: 1 };
      return ok({
        type: "workspace_created",
        workspace: state.workspaces[workspace_id],
        tab: state.tabs[tab_id],
        root_pane: paneInfo(state.panes[pane_id]),
      });
    }

    if (command === "workspace" && args[1] === "close") {
      const workspace = state.workspaces[args[2]];
      if (workspace === undefined) return fail("workspace_not_found", `workspace ${args[2]} not found`);
      state.panes = Object.fromEntries(Object.entries(state.panes).filter(([, pane]) => pane.workspace_id !== args[2]));
      state.tabs = Object.fromEntries(Object.entries(state.tabs).filter(([, tab]) => tab.workspace_id !== args[2]));
      state.workspaces = Object.fromEntries(Object.entries(state.workspaces).filter(([id]) => id !== args[2]));
      return ok({ type: "ok" });
    }

    if (command === "tab" && args[1] === "list") {
      const workspaceId = flag("--workspace");
      const tabs = Object.values(state.tabs).filter((tab) => workspaceId === undefined || tab.workspace_id === workspaceId);
      return ok({ type: "tab_list", tabs: tabs.map((tab) => tabInfo(state, tab.tab_id)) });
    }

    if (command === "tab" && args[1] === "create") {
      const workspaceId = flag("--workspace");
      const workspace = state.workspaces[workspaceId];
      if (workspace === undefined) return fail("workspace_not_found", `workspace ${workspaceId} not found`);
      const number = nextId(`${workspaceId}:t`, tabsIn(state, workspaceId));
      const tab_id = `${workspaceId}:t${number}`;
      const paneNumber = nextId(`${workspaceId}:p`, paneIdsIn(state, workspaceId));
      const pane_id = `${workspaceId}:p${paneNumber}`;
      const cwd = flag("--cwd") ?? workspace.cwd;
      state.tabs[tab_id] = { tab_id, workspace_id: workspaceId, label: flag("--label") ?? String(number), number };
      state.panes[pane_id] = { pane_id, workspace_id: workspaceId, tab_id, label: "", cwd, pid: null, x: 0, width: 1 };
      return ok({ type: "tab_created", tab: tabInfo(state, tab_id), root_pane: paneInfo(state.panes[pane_id]) });
    }

    if (command === "tab" && args[1] === "rename") {
      const tab = state.tabs[args[2]];
      if (tab === undefined) return fail("tab_not_found", `tab ${args[2]} not found`);
      tab.label = args.slice(3).join(" ");
      return ok({ type: "tab_info", tab: tabInfo(state, tab.tab_id) });
    }

    if (command === "tab" && args[1] === "close") {
      const tab = state.tabs[args[2]];
      if (tab === undefined) return fail("tab_not_found", `tab ${args[2]} not found`);
      closeTab(state, tab.tab_id);
      return ok({ type: "ok" });
    }

    if (command === "pane" && args[1] === "list") {
      const workspaceId = flag("--workspace");
      const panes = Object.values(state.panes).filter((pane) => workspaceId === undefined || pane.workspace_id === workspaceId);
      return ok({ type: "pane_list", panes: panes.map(paneInfo) });
    }

    if (command === "pane" && args[1] === "split") {
      const anchor = state.panes[args[2]];
      if (anchor === undefined) return fail("pane_not_found", `pane ${args[2]} not found`);
      const workspaceId = anchor.workspace_id;
      const n = nextId(`${workspaceId}:p`, paneIdsIn(state, workspaceId));
      const pane_id = `${workspaceId}:p${n}`;
      // Horizontal layout as fractions of the tab width: the anchor keeps `--ratio` (default 0.5) of
      // its width and the new pane takes the rest, directly to its right.
      const ratio = Number(flag("--ratio") ?? 0.5);
      const x = anchor.x + anchor.width * ratio;
      const width = anchor.width * (1 - ratio);
      anchor.width *= ratio;
      state.panes[pane_id] = { pane_id, workspace_id: workspaceId, tab_id: anchor.tab_id, label: "", cwd: anchor.cwd, pid: null, x, width };
      return ok({ type: "pane_info", pane: paneInfo(state.panes[pane_id]) });
    }

    if (command === "pane" && args[1] === "rename") {
      const pane = state.panes[args[2]];
      if (pane === undefined) return fail("pane_not_found", `pane ${args[2]} not found`);
      pane.label = args[3] ?? "";
      mkdirSync(dir, { recursive: true });
      writeFileSync(titles, `${JSON.stringify({ pane_id: pane.pane_id, label: pane.label })}\n`, { flag: "a" });
      return ok({ type: "pane_info", pane: paneInfo(pane) });
    }

    if (command === "pane" && args[1] === "run") {
      const pane = state.panes[args[2]];
      if (pane === undefined) return fail("pane_not_found", `pane ${args[2]} not found`);
      mkdirSync(panesDir, { recursive: true });
      const log = join(panesDir, `${pane.pane_id.replace(":", "-")}.log`);
      const fd = openSync(log, "a");
      const child = spawn("/bin/sh", ["-c", args[3] ?? ""], {
        cwd: pane.cwd,
        env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/bin:/usr/bin` },
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.unref();
      closeSync(fd);
      pane.pid = child.pid ?? null;
      return undefined;
    }

    if (command === "pane" && args[1] === "read") {
      const pane = state.panes[args[2]];
      if (pane === undefined) return fail("pane_not_found", `pane ${args[2]} not found`);
      const log = join(panesDir, `${pane.pane_id.replace(":", "-")}.log`);
      const text = existsSync(log) ? readFileSync(log, "utf8") : "";
      const lines = text.split("\n");
      const limit = Number(flag("--lines") ?? 80);
      process.stdout.write(`${lines.slice(-limit).join("\n")}\n`);
      return undefined;
    }

    if (command === "pane" && args[1] === "report-agent") {
      if (process.env.FAKE_HERDR_REPORT_FAIL) return fail("report_failed", "fake herdr: report-agent is disabled");
      const paneId = reportAgentPaneArg(args);
      const pane = state.panes[paneId];
      if (pane === undefined) return fail("pane_not_found", `pane ${paneId} not found`);
      pane.agent_status = flag("--state") ?? "unknown";
      pane.agent = flag("--agent");
      pane.agent_source = flag("--source");
      return undefined;
    }

    if (command === "pane" && args[1] === "move") {
      const pane = state.panes[args[2]];
      if (pane === undefined) return fail("pane_not_found", `pane ${args[2]} not found`);
      const sourceTab = pane.tab_id;
      if (args.includes("--new-tab")) {
        const workspaceId = flag("--workspace") ?? pane.workspace_id;
        const number = nextId(`${workspaceId}:t`, tabsIn(state, workspaceId));
        const tab_id = `${workspaceId}:t${number}`;
        state.tabs[tab_id] = { tab_id, workspace_id: workspaceId, label: flag("--label") ?? String(number), number };
        pane.tab_id = tab_id;
        pane.workspace_id = workspaceId;
        pane.x = 0;
        pane.width = 1;
        closeTabIfEmpty(state, sourceTab);
        return ok({ type: "pane_move" });
      }
      const tab = state.tabs[flag("--tab") ?? ""];
      if (tab === undefined) return fail("tab_not_found", `tab ${flag("--tab")} not found`);
      const anchor = state.panes[flag("--target-pane") ?? ""];
      if (anchor !== undefined && anchor.tab_id === tab.tab_id) {
        // Same geometry as `pane split`: the moved pane takes the right of the anchor.
        const ratio = Number(flag("--ratio") ?? 0.5);
        const x = anchor.x + anchor.width * ratio;
        const width = anchor.width * (1 - ratio);
        anchor.width *= ratio;
        pane.x = x;
        pane.width = width;
      } else {
        pane.x = 0;
        pane.width = 1;
      }
      pane.tab_id = tab.tab_id;
      pane.workspace_id = tab.workspace_id;
      closeTabIfEmpty(state, sourceTab);
      return ok({ type: "pane_move" });
    }

    if (command === "pane" && args[1] === "report-metadata") {
      const paneId = metadataPaneArg(args);
      const pane = state.panes[paneId];
      if (pane === undefined) return fail("pane_not_found", `pane ${paneId} not found`);
      const display = flag("--display-agent");
      if (display !== undefined) pane.display_agent = display;
      pane.metadata_source = flag("--source");
      return undefined;
    }

    if (command === "pane" && args[1] === "close") {
      const pane = state.panes[args[2]];
      if (pane === undefined) return fail("pane_not_found", `pane ${args[2]} not found`);
      const tabId = pane.tab_id;
      state.panes = Object.fromEntries(Object.entries(state.panes).filter(([id]) => id !== args[2]));
      closeTabIfEmpty(state, tabId);
      return ok({ type: "ok" });
    }

    return fail("unsupported", `fake herdr: unsupported command: ${args.join(" ")}`);
  });
} catch (err) {
  if (err instanceof Error && err.message.startsWith("fake herdr")) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
