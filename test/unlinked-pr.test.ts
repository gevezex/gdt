import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { closesIssue } from "../src/github.js";
import { editGithub, type FakeComment, gdt, type GithubData, HEAD, sleep, stateOf, stopWorlds, supervisorLog, waitFor, world, type World } from "./world.js";

afterEach(stopWorlds);

const HANDOFF = "gh fake-record 40 handoff\nexit 0\n";
const FALLBACK = "pull request #40 closes #12 in its body but GitHub has not linked it; using it";

function statusJson(w: World): Record<string, unknown> {
  return JSON.parse(gdt(w, "status", "12", "--json").stdout) as Record<string, unknown>;
}

function github(w: World): GithubData & { calls?: string[] } {
  return JSON.parse(readFileSync(w.github, "utf8")) as GithubData & { calls?: string[] };
}

/** Replaces the fake repository's pull requests; the issue itself links none unless `linked` says so. */
async function pulls(w: World, list: Record<string, { body: string; state?: string }>, linked: number[] = []): Promise<void> {
  await editGithub(w, (data) => {
    data.pulls = Object.fromEntries(Object.entries(list).map(([n, pr]) => [n, { head: HEAD, ...pr }]));
    (data.issues["12"] as { closed_by?: number[] }).closed_by = linked;
  });
}

function count(text: string, line: string): number {
  return text.split("\n").filter((l) => l.endsWith(line)).length;
}

describe("AC-1: an unlinked pull request is used when nothing is linked", { timeout: 30_000 }, () => {
  it("accepts the developer handoff on the unlinked pull request and dispatches the tester", async () => {
    const w = world({ developer: HANDOFF, handoffChecks: 2 });
    await pulls(w, { "40": { body: "Some text.\n\nCloses #12\n" } });
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });

    await waitFor("the tester turn", () => stateOf(w).role === "tester" && stateOf(w).status === "running", 20_000);
    const out = statusJson(w);
    expect(out).toMatchObject({ status: "running", role: "tester", pr_number: 40 });
    expect(supervisorLog(w)).not.toContain("finished without a visible handoff");
  });
});

describe("AC-2: the fallback is logged once per pull request", { timeout: 30_000 }, () => {
  it("logs the fallback line exactly once over many polls", async () => {
    const w = world({ developer: HANDOFF, handoffChecks: 2 });
    await pulls(w, { "40": { body: "Closes #12" } });
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });

    await waitFor("the tester turn", () => stateOf(w).role === "tester", 20_000);
    const polls = (github(w).calls ?? []).filter((c) => c.startsWith("pr list")).length;
    await waitFor("5 more polls", () => (github(w).calls ?? []).filter((c) => c.startsWith("pr list")).length >= polls + 5, 10_000);
    expect(count(supervisorLog(w), FALLBACK)).toBe(1);
  });
});

describe("AC-3: a linked pull request wins over an unlinked one", { timeout: 30_000 }, () => {
  it("uses the linked pull request, ignores the unlinked one and does not list pull requests", async () => {
    const w = world({ developer: HANDOFF, handoffChecks: 2 });
    await pulls(w, { "40": { body: "Closes #12" }, "41": { body: "Fixes #12" } }, [40]);
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });

    await waitFor("the tester turn", () => stateOf(w).role === "tester", 20_000);
    expect(statusJson(w).pr_number).toBe(40);
    expect(supervisorLog(w)).not.toContain("has not linked it");
    // Non-functional: with a linked pull request the fallback costs no extra call.
    expect((github(w).calls ?? []).some((c) => c.startsWith("pr list"))).toBe(false);
  });
});

describe("AC-4: two unlinked pull requests block as two linked ones do", { timeout: 30_000 }, () => {
  it("blocks with the same reason", async () => {
    const w = world({ handoffChecks: 2 });
    await pulls(w, { "40": { body: "Closes #12" }, "41": { body: "closes #12" } });
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });

    await waitFor("the block", () => stateOf(w).status === "blocked", 20_000);
    expect(statusJson(w).reason).toBe("more than one open pull request closes #12: #40, #41");
    expect(supervisorLog(w)).not.toContain("has not linked it");
  });
});

describe("AC-5: only a closing keyword for exactly this issue counts", { timeout: 30_000 }, () => {
  it("recognises every closing keyword, case-insensitive, for exactly the issue", () => {
    for (const word of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
      expect(closesIssue(`${word} #7`, 7)).toBe(true);
      expect(closesIssue(`Text.\n${word.toUpperCase()}\t#7.`, 7)).toBe(true);
    }
    for (const body of ["Closes #71", "Refs #7", "Closes gevezex/other#7", "Closes#7", "Encloses #7", "Closes #", ""]) {
      expect(closesIssue(body, 7)).toBe(false);
    }
  });

  it("treats pull requests without an exact closing keyword as no pull request", async () => {
    const w = world({ handoffChecks: 2 });
    await pulls(w, { "40": { body: "Closes #121" }, "41": { body: "Refs #12" }, "42": { body: "Closes gevezex/other#12" } });
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });

    await waitFor("the developer turn", () => stateOf(w).role === "developer", 20_000);
    await sleep(1_000);
    expect(statusJson(w).pr_number).toBeNull();
    expect(supervisorLog(w)).not.toContain("has not linked it");
  });
});

describe("AC-6: a closed or merged pull request does not count", { timeout: 30_000 }, () => {
  for (const state of ["CLOSED", "MERGED"]) {
    it(`ignores a ${state.toLowerCase()} pull request that closes the issue`, async () => {
      const w = world({ handoffChecks: 2 });
      await pulls(w, { "40": { body: "Closes #12", state } });
      expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });

      await waitFor("the developer turn", () => stateOf(w).role === "developer", 20_000);
      await sleep(1_000);
      expect(statusJson(w).pr_number).toBeNull();
    });
  }
});

describe("AC-7: answer and steer use the same pull requests", () => {
  it("answers a question on the unlinked pull request and steers on it", async () => {
    const w = world();
    await pulls(w, { "40": { body: "Closes #12" } });
    await editGithub(w, (data) => {
      const question = {
        role: "developer",
        repository: "gevezex/demo",
        issue: 12,
        round: 0,
        pr_number: 40,
        issue_body_sha256: "a".repeat(64),
        acceptance_criteria: ["AC-1", "AC-2"],
        question_id: "Q1",
        resume_role: "developer",
        question: "EUR or USD?",
      };
      data.comments["40"] = [
        { id: 10, author: "gevezex", created_at: new Date().toISOString(), body: `[gdt-question:v1]\n${JSON.stringify(question)}\n[/gdt-question:v1]` },
      ];
    });

    expect(gdt(w, "answer", "12", "Q1", "yes")).toMatchObject({ code: 0, stdout: "Answered Q1 on #12.\n" });
    const answers = ((github(w).comments["12"] ?? []) as FakeComment[]).filter((c) => c.body.includes("[gdt-answer:v1]"));
    expect(answers).toHaveLength(1);

    const steer = gdt(w, "steer", "12", "--role", "developer", "keep the gate");
    expect(steer).toMatchObject({ code: 0, stdout: "Posted a directive for developer on pull request #40.\n" });
    expect(((github(w).comments["40"] ?? []) as FakeComment[]).some((c) => c.body.includes("[gdt-directive:v1]"))).toBe(true);
  });
});
