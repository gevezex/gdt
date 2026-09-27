import { describe, expect, it } from "vitest";
import { paths, writeState, type State } from "../src/state.js";
import { EXAMPLE_CONFIG, fakePath, gdt, tempRepo } from "./helpers.js";

function stateWithoutSupervisor(over: Partial<State>): string {
  const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
  writeState(paths(root, 10, { PATH: process.env.PATH ?? "" }), {
    version: 1,
    issue: 10,
    workflow_id: "a1b2c3",
    status: "running",
    reason: "",
    role: null,
    round: 1,
    exit_code: null,
    repository: "gevezex/demo",
    pr_number: 25,
    head: null,
    head_transition_at: null,
    contract: null,
    dispatched: [],
    inflight: null,
    notified_status: null,
    pids: { supervisor: null, workers: {} },
    updated_at: "",
    ...over,
  });
  return root;
}

describe("AC-1: a finished workflow without a supervisor points to the merge", () => {
  it("reports ready_to_merge with the merge as next step", () => {
    const root = stateWithoutSupervisor({ status: "ready_to_merge", reason: "all gates passed" });
    const result = gdt(["status", "10", "--json"], root, fakePath());
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ready_to_merge",
      next_step: "review and merge pull request #25",
    });
    expect(gdt(["status", "10"], root, fakePath()).stdout).toBe(
      "ready_to_merge: all gates passed. Next: review and merge pull request #25\n",
    );
  });
});

describe("AC-2: other active states still detect a dead supervisor", () => {
  it.each(["running", "blocked", "awaiting_human"] as const)("%s without a supervisor points to gdt start", (status) => {
    const root = stateWithoutSupervisor({ status });
    expect(gdt(["status", "10"], root, fakePath()).stdout).toBe(
      `supervisor not running (last status: ${status}). Next: gdt start 10\n`,
    );
  });
});
