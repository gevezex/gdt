import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gdt, stateOf, stopWorlds, waitFor, world } from "./world.js";

afterEach(stopWorlds);

const ALREADY_RAN = "tester already ran for this dispatch without a usable record";

/** A tester whose record names another head than the dispatched one, so its turn leaves no usable evidence. */
function alreadyRanWorld() {
  return world({
    pr: true,
    developer: "gh fake-record 40 handoff\nexit 0\n",
    tester: `GDT_HEAD=${"a".repeat(40)} gh fake-record 40 test\nexit 0\n`,
  });
}

describe("AC-1: the supervisor remembers the key of an already-ran block", { timeout: 30_000 }, () => {
  it("names the dispatch key in blocked_key", async () => {
    const w = alreadyRanWorld();
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the already-ran block", () => stateOf(w).reason === ALREADY_RAN);
    const state = stateOf(w);
    expect(state.status).toBe("blocked");
    expect(state.blocked_key).toMatch(/^tester\.r0\./);
    expect(state.dispatched).toContain(state.blocked_key);
  });
});

describe("AC-2: retry lifts an already-ran block", { timeout: 30_000 }, () => {
  it("clears the key and dispatches the same role again", async () => {
    const w = alreadyRanWorld();
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the already-ran block", () => stateOf(w).reason === ALREADY_RAN);
    const key = stateOf(w).blocked_key;

    expect(gdt(w, "retry", "12")).toMatchObject({ code: 0, stdout: "Retry prepared for #12. Next: gdt start 12\n" });
    const retried = stateOf(w);
    expect(retried.dispatched).not.toContain(key);
    expect(retried.blocked_key).toBeNull();

    // The cause is fixed: the tester now keeps working instead of posting an unusable record.
    writeFileSync(join(w.root, "scripts/tester.sh"), "/bin/sleep 60\n");
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the tester dispatch", () => stateOf(w).status === "running" && stateOf(w).role === "tester");
    expect(gdt(w, "status", "12").stdout).toBe("running: tester turn, round 0. Next: wait\n");
  });
});

describe("AC-3: retry of a missing handoff is unchanged", { timeout: 30_000 }, () => {
  it("removes the inflight key from dispatched", async () => {
    const w = world({ developer: "exit 0\n", handoffChecks: 3 });
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("blocked", () => stateOf(w).status === "blocked");
    const key = stateOf(w).inflight?.key;
    expect(key).toMatch(/^developer\.r0\./);

    expect(gdt(w, "retry", "12")).toMatchObject({ code: 0, stdout: "Retry prepared for #12. Next: gdt start 12\n" });
    expect(stateOf(w).dispatched).not.toContain(key);
    expect(stateOf(w).inflight).toBeNull();
  });
});
