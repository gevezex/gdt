import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { alive } from "../state.js";

type Env = Record<string, string | undefined>;

/** Terminal backend interface (design 9.6). */
export interface Backend {
  ensureWorkspace(): void;
  /** Starts `argv` as a pane named `name` that outlives the caller; returns its pid. */
  spawnPane(name: string, argv: readonly string[]): number;
  setTitle(pid: number, title: string): void;
  alive(pid: number): boolean;
  /** Stops the pane's whole process group, including agent processes it started. */
  close(pid: number): void;
}

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
    alive: (pid) => alive(pid),
    close(pid) {
      killGroup(pid, "SIGTERM");
      for (let waited = 0; waited < 5000 && alive(pid); waited += 50) sleepSync(50);
      if (alive(pid)) killGroup(pid, "SIGKILL");
      for (let waited = 0; waited < 2000 && alive(pid); waited += 50) sleepSync(50);
    },
  };
}
