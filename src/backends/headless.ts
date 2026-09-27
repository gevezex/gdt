import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { alive } from "../state.js";
import type { Backend } from "./backend.js";

type Env = Record<string, string | undefined>;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** Detached processes with one log file per pane under `logs`. */
export function headless(logs: string, cwd: string, env: Env): Backend {
  return {
    ensureWorkspace: () => mkdirSync(logs, { recursive: true }),
    spawnPane(name, argv) {
      mkdirSync(logs, { recursive: true });
      const out = openSync(join(logs, `${name}.log`), "a");
      const [command, ...args] = argv;
      if (command === undefined) throw new Error("spawnPane: empty argv");
      const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", out, out] });
      child.unref();
      if (child.pid === undefined) throw new Error(`could not start ${name}`);
      return child.pid;
    },
    setTitle: () => {
      // Headless panes have no title.
    },
    setDisplayAgent: () => {
      // Headless panes have no agents overview.
    },
    reportState: () => {
      // AC-7: headless mode reports no agent state.
    },
    alive: (pid) => alive(pid),
    attach: () => null,
    close(pid) {
      killGroup(pid, "SIGTERM");
      for (let waited = 0; waited < 5000 && alive(pid); waited += 50) sleepSync(50);
      if (alive(pid)) killGroup(pid, "SIGKILL");
      for (let waited = 0; waited < 2000 && alive(pid); waited += 50) sleepSync(50);
    },
  };
}
