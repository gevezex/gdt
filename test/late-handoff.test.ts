import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gdt, sleep, stateOf, stopWorlds, supervisorLog, waitFor, world, type World } from "./world.js";

afterEach(stopWorlds);

const HANDOFF = "gh fake-record 40 handoff\nexit 0\n";

/** A temporary `XDG_DATA_HOME` holding an opencode database last written an hour ago. */
function opencodeData(): string {
  const data = mkdtempSync(join(tmpdir(), "gdt-xdg-data-"));
  mkdirSync(join(data, "opencode"));
  const database = join(data, "opencode", "opencode.db");
  writeFileSync(database, "");
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(database, old, old);
  return data;
}

/** Installs a fake `opencode` that runs `script` and exits 0 at once. */
function fakeOpencode(w: World, script: string): void {
  writeFileSync(join(w.bin, "opencode"), `#!/bin/sh\n${script}exit 0\n`);
  chmodSync(join(w.bin, "opencode"), 0o755);
}

/** A detached child that appends to the opencode write-ahead log `times` times, every `every` seconds, then runs `then`. */
function walWriter(times: number, every: number, then = ""): string {
  const write = 'echo x >> "$XDG_DATA_HOME/opencode/opencode.db-wal"';
  return `( i=0; while [ $i -lt ${times} ]; do ${write}; /bin/sleep ${every}; i=$((i+1)); done; ${then} ) >/dev/null 2>&1 &\n`;
}

function statusJson(w: World): Record<string, unknown> {
  return JSON.parse(gdt(w, "status", "12", "--json").stdout) as Record<string, unknown>;
}

function handoffLines(w: World): string[] {
  return supervisorLog(w)
    .split("\n")
    .filter((line) => line.includes("handoff check"));
}

/** Waits until the tester turn has a result file, and returns the workflow's status snapshots meanwhile. */
async function watchStatuses(w: World, until: () => boolean, ms: number): Promise<string[]> {
  const seen: string[] = [];
  await waitFor("the condition", () => {
    seen.push(stateOf(w).status);
    return until();
  }, ms);
  return seen;
}

interface WorldOptions {
  handoffChecks?: number;
  turnTimeoutMinutes?: number;
  turnMaxMinutes?: number;
  tester?: "opencode" | "claude";
}

function opencodeWorld(options: WorldOptions = {}): World {
  return world({
    pr: true,
    developer: HANDOFF,
    roleAgents: { tester: options.tester ?? "opencode" },
    pollSeconds: 1,
    handoffChecks: options.handoffChecks ?? 2,
    ...(options.turnTimeoutMinutes === undefined ? {} : { turnTimeoutMinutes: options.turnTimeoutMinutes }),
    ...(options.turnMaxMinutes === undefined ? {} : { turnMaxMinutes: options.turnMaxMinutes }),
    env: { XDG_DATA_HOME: opencodeData() },
  });
}

describe("AC-1: a record after exit, during post-exit activity, is accepted", { timeout: 40_000 }, () => {
  it("accepts the tester record that arrives 10 seconds after the agent exited and dispatches the reviewer", async () => {
    const w = opencodeWorld();
    fakeOpencode(w, walWriter(10, 1, "gh fake-record 40 test"));
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the tester turn", () => stateOf(w).role === "tester");

    const seen = await watchStatuses(w, () => stateOf(w).role === "reviewer", 25_000);
    expect(seen).not.toContain("blocked");
    const out = statusJson(w);
    expect(out.status).toBe("running");
    expect(out.role).toBe("reviewer");
    expect(supervisorLog(w)).not.toContain("finished without a visible handoff");
  });
});

describe("AC-2: checks with post-exit activity do not count", { timeout: 40_000 }, () => {
  it("logs active checks without counting them and reports the waiting reason", async () => {
    const w = opencodeWorld();
    fakeOpencode(w, walWriter(10, 1, "gh fake-record 40 test"));
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });

    await waitFor("an active handoff check", () => handoffLines(w).some((line) => line.includes("agent still active")), 15_000);
    expect(stateOf(w)).toMatchObject({ status: "running", reason: "waiting for the tester handoff; agent exited but is still active" });
    await waitFor("the reviewer turn", () => stateOf(w).role === "reviewer", 25_000);

    const lines = handoffLines(w);
    expect(lines.some((line) => /handoff check for tester\.r\d+\..*: not visible, agent still active \(opencode=yes\)$/.test(line))).toBe(true);
    expect(lines.some((line) => line.includes("handoff check 2/2"))).toBe(false);
  });
});

describe("AC-3: without post-exit activity, behaviour is unchanged", { timeout: 30_000 }, () => {
  for (const agent of ["opencode", "claude"] as const) {
    it(`blocks a silent ${agent} tester after 2 missed checks`, async () => {
      const w = opencodeWorld({ tester: agent });
      if (agent === "opencode") fakeOpencode(w, "");
      else {
        writeFileSync(join(w.bin, "claude"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(w.bin, "claude"), 0o755);
      }
      expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });

      await waitFor("the block", () => stateOf(w).status === "blocked", 20_000);
      const out = statusJson(w);
      expect(out.reason).toBe("tester finished without a visible handoff");
      expect(out.next_step).toBe("gdt retry 12");
      const lines = handoffLines(w);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/handoff check 1\/2 for tester\.r\d+\.\S+: not visible$/);
      expect(lines[1]).toMatch(/handoff check 2\/2 for tester\.r\d+\.\S+: not visible$/);
    });
  }
});

describe("AC-4: post-exit activity up to the hard limit blocks", { timeout: 30_000 }, () => {
  it("blocks a tester that keeps its session active without a record at the 0.1-minute hard limit", async () => {
    const w = opencodeWorld({ handoffChecks: 5, turnTimeoutMinutes: 0.05, turnMaxMinutes: 0.1 });
    fakeOpencode(w, walWriter(40, 0.5));
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the tester turn", () => stateOf(w).role === "tester" && stateOf(w).inflight !== null);

    const dispatchedAt = Date.parse(stateOf(w).inflight?.dispatched_at as string);
    const wait = dispatchedAt + 7_000 - Date.now();
    if (wait > 0) await sleep(wait);
    await waitFor("the hard-limit block", () => stateOf(w).status === "blocked", 2_000);
    const out = statusJson(w);
    expect(out.reason).toBe("tester exited without a visible handoff and stayed active until the 0.1-minute hard limit");
    expect(out.next_step).toBe("gdt retry 12");
  });
});

describe("AC-5: a late record lifts the block", { timeout: 40_000 }, () => {
  it("clears the missing-handoff block when the tester record appears after it", async () => {
    const trigger = join(mkdtempSync(join(tmpdir(), "gdt-trigger-")), "post-record");
    // The detached child posts the tester record once the test creates the trigger file.
    const tester = `( while [ ! -f "${trigger}" ]; do /bin/sleep 0.1; done; gh fake-record 40 test ) >/dev/null 2>&1 &\nexit 0\n`;
    const w = world({ pr: true, developer: HANDOFF, tester, pollSeconds: 1, handoffChecks: 2 });
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });

    await waitFor("the block", () => stateOf(w).status === "blocked", 20_000);
    expect(stateOf(w).reason).toBe("tester finished without a visible handoff");
    await sleep(5_000);
    writeFileSync(trigger, "");

    await waitFor("the reviewer turn", () => stateOf(w).role === "reviewer" && stateOf(w).status === "running", 5_000);
    const out = statusJson(w);
    expect(out.status).toBe("running");
    expect(out.role).toBe("reviewer");
    expect(supervisorLog(w)).toMatch(/late handoff for tester\.r\d+\.\S+ accepted/);
  });
});
