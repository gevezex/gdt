import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPrompt, type PromptDispatch } from "../src/prompts.js";
import { gdt, stateOf, stopWorlds, supervisorLog, waitFor, world, type World } from "./world.js";

afterEach(stopWorlds);

const dispatch = (over: Partial<PromptDispatch> = {}): PromptDispatch => ({
  repository: "gevezex/demo",
  issue: 12,
  round: 0,
  pr_number: 40,
  head: "b".repeat(40),
  issue_body_sha256: "a".repeat(64),
  acceptance_criteria: ["AC-1", "AC-2"],
  language: "en",
  directives: [],
  ...over,
});

/** The tester posts a `[gdt-test:v1]` record with an extra `"$schema"` key, which the schema rejects. */
const INVALID_TESTER = "gh fake-record 40 test --extra-schema\nexit 0\n";

/** A world where the developer hands off and the tester then posts an invalid record and blocks. */
function invalidWorld(handoffChecks = 3): World {
  return world({
    pr: true,
    developer: "gh fake-record 40 handoff\nexit 0\n",
    tester: INVALID_TESTER,
    handoffChecks,
  });
}

/** The worker's recorded prompt for one dispatch key (`.git/gdt/issue-12/runs/<key>.prompt.md`). */
function promptPath(root: string, key: string): string {
  return join(root, ".git", "gdt", "issue-12", "runs", `${key}.prompt.md`);
}

describe("AC-1: an invalid record is reported with its validation error", { timeout: 30_000 }, () => {
  it("blocks naming the role, marker, comment id and error, and offers gdt retry", async () => {
    const w = invalidWorld();
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("blocked", () => stateOf(w).status === "blocked");

    const state = stateOf(w);
    expect(state.inflight).toMatchObject({ checks: 3, missing: true });
    expect(state.reason).toContain("tester posted an invalid record [gdt-test:v1]");
    expect(state.reason).toMatch(/in comment \d+/);
    expect(state.reason).toContain('schema: unrecognized key "$schema"');

    // Every handoff check line names the validation error instead of "not visible".
    const log = supervisorLog(w);
    expect(log).toMatch(/handoff check 3\/3 .*unrecognized key "\$schema"/);
    expect(log).not.toContain("not visible");

    expect(gdt(w, "status", "12").stdout).toMatch(/^blocked: tester posted an invalid record \[gdt-test:v1\].*Next: gdt retry 12\n$/);
    const json = JSON.parse(gdt(w, "status", "12", "--json").stdout) as { status: string; reason: string; next_step: string };
    expect(json.status).toBe("blocked");
    expect(json.reason).toContain('unrecognized key "$schema"');
    expect(json.next_step).toBe("gdt retry 12");
  });
});

describe("AC-2: the retried turn gets the validation error in its prompt", { timeout: 30_000 }, () => {
  it("names the comment id and error in the role's next prompt", async () => {
    const w = invalidWorld();
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("blocked", () => stateOf(w).status === "blocked");

    const reason = stateOf(w).reason;
    const key = stateOf(w).inflight?.key ?? "";
    const commentId = /in comment (\d+)/.exec(reason)?.[1];
    expect(key).toMatch(/^tester\.r0\./);
    expect(commentId).toBeDefined();

    expect(gdt(w, "retry", "12")).toMatchObject({ code: 0, stdout: "Retry prepared for #12. Next: gdt start 12\n" });
    // The retried tester keeps running, so the recorded prompt is not overwritten by another record.
    writeFileSync(join(w.root, "scripts/tester.sh"), "/bin/sleep 60\n");
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the retried tester prompt", () => {
      try {
        return readFileSync(promptPath(w.root, key), "utf8").includes('unrecognized key "$schema"');
      } catch {
        return false;
      }
    });

    const prompt = readFileSync(promptPath(w.root, key), "utf8");
    expect(prompt).toContain(`in comment ${commentId}`);
    expect(prompt).toContain('unrecognized key "$schema"');
    expect(prompt).toMatch(/matches the schema exactly/);
  });
});

describe("AC-3: role prompts show record schemas without a $schema key", () => {
  const project = { root: mkdtempSync(join(tmpdir(), "gdt-prompt-")) };

  it.each(["developer", "tester", "reviewer"] as const)("the %s prompt embeds no $schema key and forbids it", (role) => {
    const prompt = buildPrompt(role, dispatch(), project);
    expect(prompt).not.toContain('"$schema": "https://json-schema.org');
    expect(prompt).toContain('The record must not contain a `"$schema"` key.');
  });
});

describe("AC-4: a missing record still gives the existing message", { timeout: 30_000 }, () => {
  it("keeps the message, the not-visible log and the retry hint", async () => {
    const w = world({ developer: "exit 0\n", handoffChecks: 3 });
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("blocked", () => stateOf(w).status === "blocked");

    const state = stateOf(w);
    expect(state.reason).toBe("developer finished without a visible handoff");
    expect(state.retry_record ?? null).toBeNull();
    const log = supervisorLog(w);
    expect(log).toContain("handoff check 3/3");
    expect(log).toContain("not visible");
    expect(gdt(w, "status", "12").stdout).toBe("blocked: developer finished without a visible handoff. Next: gdt retry 12\n");
  });
});
