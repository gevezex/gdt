import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLI, gdt, lockPid, sleep, stateOf, stopWorlds, waitFor, world, type World } from "./world.js";

afterEach(stopWorlds);

const DEAD_SUPERVISOR = "supervisor not running (last status: running). Next: gdt start 12\n";

/** Runs `gdt wait` in the background, so the test can act while it blocks. */
function startWait(w: World, ...args: string[]): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(process.execPath, [CLI, "wait", "12", ...args], { cwd: w.root, env: w.env });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout })));
}

/** A pid that belonged to a process which has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

async function runningWorld(): Promise<World> {
  const w = world({ developer: "/bin/sleep 60\n", handoffChecks: 10_000 });
  expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
  await waitFor("running", () => stateOf(w).status === "running" && lockPid(w) !== null);
  return w;
}

describe("AC-1: wait reports a deliberate stop as stopped", { timeout: 60_000 }, () => {
  it("prints stopped for repeated stops", async () => {
    for (let run = 0; run < 5; run += 1) {
      const w = await runningWorld();
      const waiting = startWait(w);
      await sleep(300);
      expect(gdt(w, "stop", "12").code).toBe(0);
      expect(await waiting).toEqual({ code: 0, stdout: "stopped. Next: gdt start 12\n" });
    }
  });

  it("keeps waiting through the stop window while the stopping process lives", async () => {
    const w = await runningWorld();
    const dir = join(w.root, ".git/gdt/issue-12");
    // Freeze the stop window: the supervisor is gone, the final state is not written yet.
    process.kill(lockPid(w) as number, "SIGKILL");
    writeFileSync(join(dir, "stopping"), `${process.pid}\n`);

    expect(await startWait(w, "--timeout", "1")).toEqual({ code: 1, stdout: "" });

    const waiting = startWait(w);
    await sleep(300);
    const state = stateOf(w);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...state, status: "stopped", reason: "" }));
    expect(await waiting).toEqual({ code: 0, stdout: "stopped. Next: gdt start 12\n" });
  });
});

describe("AC-2: a crashed supervisor is still detected", { timeout: 30_000 }, () => {
  it("returns the dead-supervisor line within 2 seconds after SIGKILL", async () => {
    const w = await runningWorld();
    const waiting = startWait(w);
    await sleep(300);
    const killedAt = Date.now();
    process.kill(lockPid(w) as number, "SIGKILL");
    expect(await waiting).toEqual({ code: 0, stdout: DEAD_SUPERVISOR });
    expect(Date.now() - killedAt).toBeLessThan(2000);
  });
});

describe("AC-3: a crashed stop does not block wait forever", { timeout: 30_000 }, () => {
  it("ignores a stop marker whose process has exited", async () => {
    const w = await runningWorld();
    process.kill(lockPid(w) as number, "SIGKILL");
    writeFileSync(join(w.root, ".git/gdt/issue-12/stopping"), `${deadPid()}\n`);
    const startedAt = Date.now();
    expect(await startWait(w)).toEqual({ code: 0, stdout: DEAD_SUPERVISOR });
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
