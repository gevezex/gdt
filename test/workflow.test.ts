import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { notify } from "../src/notify.js";
import { alive } from "../src/state.js";
import { BODY, CLI, editGithub, GIT, gdt, HEAD, lines, lockPid, sleep, stateOf, stopWorlds, supervisorLog, waitFor, world } from "./world.js";

afterEach(stopWorlds);


describe("AC-1: start returns and the supervisor keeps running", { timeout: 30_000 }, () => {
  it("exits 0 within 5 seconds from a shell that exits, leaving the supervisor running", () => {
    const w = world({ developer: "/bin/sleep 60\n" });
    const began = Date.now();
    const result = spawnSync("/bin/sh", ["-c", `"${process.execPath}" "${CLI}" start 12`], { cwd: w.root, env: w.env, encoding: "utf8" });
    expect(Date.now() - began).toBeLessThan(5000);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Supervisor started for #12; logs: .git/gdt/issue-12/logs");
    const pid = lockPid(w);
    expect(pid).not.toBeNull();
    expect(alive(pid)).toBe(true);
    expect(stateOf(w).pids.supervisor).toBe(pid);
  });
});

describe("AC-2: one supervisor per issue", { timeout: 30_000 }, () => {
  it("refuses a second start and starts nothing new", () => {
    const w = world({ developer: "/bin/sleep 60\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    const pid = lockPid(w);
    const again = gdt(w, "start", "12");
    expect(again.code).toBe(1);
    expect(again.stderr).toBe(`Supervisor for #12 is already running (pid ${pid})\n`);
    expect(lockPid(w)).toBe(pid);
    expect(stateOf(w).pids.supervisor).toBe(pid);
  });
});

describe("AC-3: a dispatch runs exactly once", { timeout: 30_000 }, () => {
  it("does not rerun the developer after a stop and restart before the handoff", async () => {
    const counter = join(tmpdir(), `gdt-counter-${process.pid}-${Date.now()}`);
    const w = world({ developer: `echo run >> "${counter}"\nexit 0\n`, handoffChecks: 10_000 });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the developer turn", () => lines(counter).length === 1 && stateOf(w).inflight?.checks !== 0);
    const key = stateOf(w).inflight?.key;

    expect(gdt(w, "stop", "12").code).toBe(0);
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("more handoff checks", () => (stateOf(w).inflight?.checks ?? 0) > 5);
    await sleep(1000);

    expect(lines(counter)).toEqual(["run"]);
    const state = stateOf(w);
    expect(state.inflight?.key).toBe(key);
    expect(state.dispatched).toEqual([key]);
  });
});

describe("AC-4: a failing agent turn stops the workflow with a recovery hint", { timeout: 30_000 }, () => {
  it("records failed, exits the supervisor and names the next step", async () => {
    const w = world({ developer: "exit 3\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    const pid = lockPid(w);
    await waitFor("failed", () => stateOf(w).status === "failed");
    await waitFor("the supervisor to exit", () => !alive(pid));
    const state = stateOf(w);
    expect(state).toMatchObject({ role: "developer", exit_code: 3 });
    await waitFor("the workers to exit", () => Object.values(state.pids.workers).every((p) => !alive(p)));

    const status = gdt(w, "status", "12");
    expect(status.stdout).toBe("developer turn failed (exit code 3). Next: gdt retry 12\n");
    expect(status.code).toBe(0);

    // stop keeps the failure, and start points to retry instead of resuming.
    expect(gdt(w, "stop", "12").code).toBe(0);
    expect(gdt(w, "status", "12").stdout).toBe("developer turn failed (exit code 3). Next: gdt retry 12\n");
    expect(gdt(w, "start", "12")).toMatchObject({
      code: 1,
      stderr: "Workflow for #12 failed: developer turn failed (exit code 3). Next: gdt retry 12\n",
    });
  });
});

describe("AC-5: a missing handoff is detected within a bounded number of checks", { timeout: 30_000 }, () => {
  it("blocks after handoff_checks fresh checks", async () => {
    const w = world({ developer: "exit 0\n", handoffChecks: 5 });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("blocked", () => stateOf(w).status === "blocked");
    const state = stateOf(w);
    expect(state.reason).toBe("developer finished without a visible handoff");
    expect(state.inflight).toMatchObject({ checks: 5, missing: true });
    expect(supervisorLog(w)).toContain("handoff check 5/5");
    expect(gdt(w, "status", "12").stdout).toBe("blocked: developer finished without a visible handoff. Next: gdt retry 12\n");
  });

  it("stays blocked with the retry hint after a stop and start", async () => {
    const w = world({ developer: "exit 0\n", handoffChecks: 3 });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("blocked", () => stateOf(w).status === "blocked");
    expect(gdt(w, "stop", "12").code).toBe(0);
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("blocked again", () => stateOf(w).status === "blocked");
    expect(gdt(w, "status", "12").stdout).toBe("blocked: developer finished without a visible handoff. Next: gdt retry 12\n");
    expect(lines(join(w.bin, "notifications"))).toHaveLength(1);
  });

  it("continues when the record appears on the third check", async () => {
    const w = world({ developer: "gh fake-record 40 handoff --hidden-reads 2\nexit 0\n", pr: true, handoffChecks: 5 });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the tester dispatch", () => stateOf(w).role === "tester");
    const log = supervisorLog(w);
    expect(log).toContain("handoff check 2/5");
    expect(log).not.toContain("handoff check 3/5");
    expect(log).not.toContain("status blocked");
    expect(stateOf(w)).toMatchObject({ status: "running", round: 0, pr_number: 40, head: HEAD });
  });
});

describe("AC-6: stop and resume keep the workflow identity", { timeout: 30_000 }, () => {
  it("stops every process, then resumes with the same workflow id and no repeated key", async () => {
    const w = world({ developer: "exit 0\n", handoffChecks: 10_000 });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the developer dispatch", () => (stateOf(w).inflight?.checks ?? 0) > 0);
    const before = stateOf(w);
    const pids = [before.pids.supervisor, ...Object.values(before.pids.workers)];
    expect(pids).toHaveLength(4);

    expect(gdt(w, "stop", "12")).toMatchObject({ code: 0, stdout: "Stopped #12. Next: gdt start 12\n" });
    for (const pid of pids) expect(alive(pid)).toBe(false);
    expect(gdt(w, "status", "12").stdout).toBe("stopped. Next: gdt start 12\n");

    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the resumed supervisor", () => stateOf(w).status === "running");
    const after = stateOf(w);
    expect(after.workflow_id).toBe(before.workflow_id);
    expect(after.workflow_id).toMatch(/^[0-9a-f]{6}$/);
    expect(after.dispatched).toEqual(before.dispatched);
    expect(new Set(after.dispatched).size).toBe(after.dispatched.length);
  });

  it("also stops a running agent turn", async () => {
    const agentPid = join(tmpdir(), `gdt-agent-${process.pid}-${Date.now()}`);
    const w = world({ developer: `echo $$ > "${agentPid}"\n/bin/sleep 60\n` });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the agent", () => lines(agentPid).length === 1);
    const pid = Number(lines(agentPid)[0]);
    expect(alive(pid)).toBe(true);
    gdt(w, "stop", "12");
    expect(alive(pid)).toBe(false);
  });
});

describe("AC-7: unknown working-tree changes block Round 0", { timeout: 30_000 }, () => {
  it("lists the changed files and starts nothing", () => {
    const w = world({ extraFiles: { "src/a.ts": "export {};\n" } });
    writeFileSync(join(w.root, "src/a.ts"), "export const a = 1;\n");
    const result = gdt(w, "start", "12");
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("Working tree not clean: src/a.ts. Commit or stash before starting.\n");
    expect(lockPid(w)).toBeNull();
    expect(existsSync(join(w.root, ".git/gdt/issue-12/state.json"))).toBe(false);
  });

  it("lists renamed and untracked files, including names with spaces", () => {
    const w = world({ extraFiles: { "src/a.ts": "export {};\n" } });
    spawnSync(GIT, ["mv", "src/a.ts", "src/b c.ts"], { cwd: w.root });
    writeFileSync(join(w.root, "new.txt"), "x\n");
    expect(gdt(w, "start", "12").stderr).toBe("Working tree not clean: src/b c.ts, new.txt. Commit or stash before starting.\n");
  });

  it("refuses an invalid issue contract", async () => {
    const w = world();
    await editGithub(w, (data) => {
      data.issues["12"] = { body: BODY.replace("## Out of scope", "## Outside") };
    });
    const result = gdt(w, "start", "12");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Missing section: Out of scope");
  });
});

describe("AC-8: status changes notify once", { timeout: 30_000 }, () => {
  it("sends one notification while awaiting_human persists over many polls", async () => {
    const w = world({ developer: "gh fake-record 12 question\nexit 0\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("awaiting_human", () => stateOf(w).status === "awaiting_human");
    const polls = (JSON.parse(readFileSync(w.github, "utf8")) as { calls: string[] }).calls.length;
    await waitFor("ten more polls", () => (JSON.parse(readFileSync(w.github, "utf8")) as { calls: string[] }).calls.length > polls + 40);
    const sent = lines(join(w.bin, "notifications"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("gdt #12: awaiting_human");
  });

  it("falls back to one line in the supervisor log without a notifier", async () => {
    const w = world({ developer: "exit 3\n", notifier: false });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("failed", () => stateOf(w).status === "failed");
    const log = supervisorLog(w);
    expect(log.match(/notification: gdt #12: failed: developer turn failed \(exit code 3\)/g)).toHaveLength(1);
  });

  it("uses the first available notifier in order", () => {
    const bin = mkdtempSync(join(tmpdir(), "gdt-bin-"));
    for (const name of ["osascript", "notify-send"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> "${join(bin, "used")}"\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const logged: string[] = [];
    expect(notify("gdt #12: blocked", "reason", { PATH: bin }, (line) => logged.push(line))).toBe("osascript");
    expect(lines(join(bin, "used"))).toEqual(["osascript"]);
    expect(logged).toEqual([]);
  });
});

describe("contract changes", { timeout: 30_000 }, () => {
  it("blocks on a body change without a Changelog change, and resets on one with it", async () => {
    const w = world({ developer: "gh fake-record 12 question\nexit 0\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("awaiting_human", () => stateOf(w).status === "awaiting_human");

    const edit = (body: string) =>
      editGithub(w, (data) => {
        data.issues["12"] = { body };
      });
    await edit(BODY.replace("- Context.", "- Context, changed."));
    await waitFor("blocked", () => stateOf(w).status === "blocked");
    expect(stateOf(w).reason).toBe("issue body changed without a Changelog update");

    await edit(BODY.replace("- Context.", "- Context, changed.").replace("- 2026-09-26: Initial.", "- 2026-09-26: Initial.\n- 2026-09-27: Context changed."));
    await waitFor("contract_changed", () => supervisorLog(w).includes("status contract_changed"));
    await waitFor("a new developer dispatch", () => stateOf(w).dispatched.length === 2);
  });
});
