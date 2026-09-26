import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Decision, decide, type Snapshot } from "../src/decision.js";
import { type Comment, KINDS, marker, parseRecords, type ProtocolRecord, type RecordData, schemas } from "../src/protocol.js";
import { dispatchKey } from "../src/supervisor.js";

const REPO = "gevezex/demo";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const AAA = "a".repeat(40);
const BBB = "b".repeat(40);
const ACS = ["AC-1", "AC-2"];
const USER = "gevezex";

let nextId = 1;
/** Minute `n` after a fixed epoch; the engine only ever compares these. */
function at(n: number): string {
  return new Date(Date.UTC(2026, 8, 26, 10, n)).toISOString();
}

function rec<K extends ProtocolRecord["kind"]>(kind: K, data: RecordData[K], minute: number, author = USER): ProtocolRecord {
  return { kind, data, author, created_at: at(minute), comment_id: nextId++ } as ProtocolRecord;
}

const core = (round: number) => ({
  repository: REPO,
  issue: 12,
  round,
  pr_number: 40,
  issue_body_sha256: HASH,
  acceptance_criteria: ACS,
});

function handoff(minute: number, round = 0, over: Partial<RecordData["handoff"]> = {}): ProtocolRecord {
  return rec(
    "handoff",
    {
      role: "developer",
      status: "ready",
      ...core(round),
      ac_traceability: ACS.map((ac) => ({ ac, files: ["src/a.ts"], tests: ["test/a.test.ts"] })),
      assumptions: [],
      deviations: [],
      ...over,
    },
    minute,
  );
}

type VerifierOver = Partial<RecordData["test"]> & { author?: string };

function verifier(kind: "test" | "review", minute: number, over: VerifierOver = {}): ProtocolRecord {
  const { author, ...data } = over;
  const role = kind === "test" ? "tester" : "reviewer";
  return rec(
    kind,
    {
      role,
      status: "approved",
      ...core(0),
      head: BBB,
      ac_results: ACS.map((ac) => ({ ac, result: "passed" as const, evidence: "test passes" })),
      findings: [],
      ...data,
    } as RecordData["test"],
    minute,
    author,
  );
}
const test = (minute: number, over: VerifierOver = {}) => verifier("test", minute, over);
const review = (minute: number, over: VerifierOver = {}) => verifier("review", minute, over);

function snapshot(records: ProtocolRecord[], over: Partial<Snapshot> = {}): Snapshot {
  return {
    repository: REPO,
    issue: 12,
    records,
    trusted_authors: [USER],
    pr: { number: 40, head: BBB, mergeable: "mergeable", checks: { ci: "success" } },
    issue_body_sha256: HASH,
    acceptance_criteria: ACS,
    head_transition_at: at(1),
    config: { max_correction_rounds: 2, required_checks: ["ci"], allow_no_required_checks: false },
    ...over,
  };
}

type Case = [name: string, snapshot: Snapshot, expected: Partial<Decision>];

function table(cases: Case[]) {
  it.each(cases)("%s", (_name, input, expected) => {
    expect(decide(input)).toMatchObject(expected);
  });
}

function comment(body: string, id = 1): Comment {
  return { id, author: USER, created_at: at(0), body };
}

function block(kind: (typeof KINDS)[number], content: string): string {
  return `Prose above.\n\n${marker(kind)}\n${content}\n${marker(kind, true)}\n`;
}

describe("AC-1: records are parsed; invalid ones are ignored with a reason", () => {
  const valid = (test(5) as Extract<ProtocolRecord, { kind: "test" }>).data;

  it.each([
    ["invalid JSON", "{ not json", "invalid JSON"],
    ["an unknown field", JSON.stringify({ ...valid, foo: 1 }), 'schema: unrecognized key "foo"'],
    ["a wrong status", JSON.stringify({ ...valid, status: "ready" }), "schema: status:"],
    ["a short head", JSON.stringify({ ...valid, head: "abc" }), "schema: head: expected a full 40-character commit SHA"],
  ])("excludes %s and names the reason", (_name, bad, reason) => {
    const { records, diagnostics } = parseRecords([comment(block("test", JSON.stringify(valid)), 1), comment(block("test", bad), 2)]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "test", comment_id: 1, author: USER, data: valid });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ comment_id: 2, kind: "test" });
    expect(diagnostics[0]?.reason.startsWith(reason)).toBe(true);
  });

  it("reads several records per comment, a JSON code fence, and ignores mismatched markers", () => {
    const answer = { repository: REPO, issue: 12, question_id: "Q1", answer: "Gebruik EUR" };
    const body = [
      block("answer", `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``),
      block("round", JSON.stringify({ repository: REPO, issue: 12, round: 3 })),
      `${marker("directive")} {} ${marker("round", true)}`,
    ].join("\n");
    const { records, diagnostics } = parseRecords([comment(body)]);
    expect(records.map((r) => r.kind)).toEqual(["answer", "round"]);
    expect(records[0]?.data).toEqual(answer);
    expect(diagnostics).toEqual([]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("reads a fenced record with %s line endings", (_name, eol) => {
    const answer = { repository: REPO, issue: 12, question_id: "Q1", answer: "EUR" };
    const body = [marker("answer"), "```json", JSON.stringify(answer), "```", marker("answer", true)].join(eol);
    const { records, diagnostics } = parseRecords([comment(body)]);
    expect(records.map((r) => r.data)).toEqual([answer]);
    expect(diagnostics).toEqual([]);
  });
});

describe("AC-2: untrusted authors and other issue hashes are ignored", () => {
  table([
    ["untrusted approved tester record after a handoff", snapshot([handoff(2), test(3, { author: "mallory" })]), { action: "dispatch", role: "tester" }],
    [
      "tester record with another issue body hash",
      snapshot([handoff(2), test(3, { issue_body_sha256: OTHER_HASH })]),
      { action: "dispatch", role: "tester" },
    ],
    ["untrusted handoff", snapshot([rec("handoff", (handoff(2) as Extract<ProtocolRecord, { kind: "handoff" }>).data, 2, "mallory")]), { action: "dispatch", role: "developer", round: 0 }],
    ["record for another issue", snapshot([handoff(2), test(3, { issue: 13 })]), { action: "dispatch", role: "tester" }],
    ["trusted record from the same snapshot", snapshot([handoff(2), test(3)]), { action: "dispatch", role: "reviewer" }],
  ]);
});

describe("AC-3: evidence is bound to the current head", () => {
  table([
    ["approved tester record for another head", snapshot([handoff(2), test(3, { head: AAA })]), { action: "dispatch", role: "tester", round: 0 }],
    ["approved tester record for the current head after the transition", snapshot([handoff(2), test(3)]), { action: "dispatch", role: "reviewer", round: 0 }],
    ["reviewer record for another head", snapshot([handoff(2), test(3), review(4, { head: AAA })]), { action: "dispatch", role: "reviewer" }],
    ["no handoff yet", snapshot([], { pr: null }), { action: "dispatch", role: "developer", round: 0 }],
  ]);
});

describe("AC-4: evidence from before a head transition does not count", () => {
  // Head went aaa → bbb → aaa; the last transition (back to aaa) happened at minute 10.
  const pr = { number: 40, head: AAA, mergeable: "mergeable" as const, checks: { ci: "success" as const } };
  table([
    ["tester record for aaa created before the last transition", snapshot([handoff(2), test(5, { head: AAA })], { pr, head_transition_at: at(10) }), { action: "dispatch", role: "tester" }],
    ["tester record for aaa created after the transition", snapshot([handoff(2), test(11, { head: AAA })], { pr, head_transition_at: at(10) }), { action: "dispatch", role: "reviewer" }],
    ["tester record older than the latest handoff", snapshot([handoff(2), test(3), handoff(4, 1)]), { action: "dispatch", role: "tester", round: 1 }],
  ]);
});

describe("AC-5: round budget ends in blocked, and a round grant extends it", () => {
  const changes = (round: number, minute: number) =>
    test(minute, { round, status: "changes_requested", findings: [{ id: "T-3", blocking: true, summary: "wrong total" }] });
  const grant = (round: number, minute: number) => rec("round", { repository: REPO, issue: 12, round }, minute);
  table([
    ["changes_requested on round 1", snapshot([handoff(2, 1), changes(1, 3)]), { action: "dispatch", role: "developer", round: 2 }],
    [
      "changes_requested on the last round",
      snapshot([handoff(2, 2), changes(2, 3)]),
      { action: "blocked", reason: "round budget exhausted; open findings: T-3" },
    ],
    ["with a later round grant", snapshot([handoff(2, 2), changes(2, 3), grant(3, 4)]), { action: "dispatch", role: "developer", round: 3 }],
    ["verifier record with a stale round after a round-2 handoff", snapshot([handoff(2, 2), changes(0, 3)]), { action: "blocked", reason: "round budget exhausted; open findings: T-3" }],
    ["with an untrusted round grant", snapshot([handoff(2, 2), changes(2, 3), rec("round", { repository: REPO, issue: 12, round: 3 }, 4, "mallory")]), { action: "blocked" }],
    [
      "reviewer changes_requested on the last round",
      snapshot([handoff(2, 2), test(3, { round: 2 }), review(4, { round: 2, status: "changes_requested", findings: [{ id: "R-1", blocking: true, summary: "x" }] })]),
      { action: "blocked", reason: "round budget exhausted; open findings: R-1" },
    ],
  ]);
});

describe("AC-6: question and answer resume the waiting role", () => {
  const question = (id: string, minute: number) =>
    rec("question", { role: "tester", ...core(1), question_id: id, resume_role: "tester", question: "EUR or USD?" }, minute);
  const answer = (id: string, minute: number, author = USER) =>
    rec("answer", { repository: REPO, issue: 12, question_id: id, answer: "Gebruik EUR" }, minute, author);
  const waiting = test(3, { round: 1, status: "awaiting_human" });
  table([
    ["question without an answer", snapshot([handoff(2, 1), waiting, question("Q1", 4)]), { action: "awaiting_human", reason: "waiting for an answer to Q1" }],
    ["question with an answer", snapshot([handoff(2, 1), waiting, question("Q1", 4), answer("Q1", 5)]), { action: "dispatch", role: "tester", round: 1 }],
    ["answer for another question", snapshot([handoff(2, 1), waiting, question("Q1", 4), answer("Q2", 5)]), { action: "awaiting_human" }],
    ["untrusted answer", snapshot([handoff(2, 1), waiting, question("Q1", 4), answer("Q1", 5, "mallory")]), { action: "awaiting_human" }],
    ["resumed role has published since", snapshot([handoff(2, 1), waiting, question("Q1", 4), answer("Q1", 5), test(6, { round: 1 })]), { action: "dispatch", role: "reviewer", round: 1 }],
  ]);
});

describe("AC-7: ready_to_merge requires every gate", () => {
  const approved = [handoff(2), test(3), review(4)];
  const pr = (over: Partial<NonNullable<Snapshot["pr"]>>) => ({ number: 40, head: BBB, mergeable: "mergeable" as const, checks: { ci: "success" as const, lint: "success" as const }, ...over });
  const config = { max_correction_rounds: 2, required_checks: ["ci", "lint"], allow_no_required_checks: false };
  table([
    ["every gate holds", snapshot(approved, { pr: pr({}), config }), { action: "ready_to_merge" }],
    ["one required check pending", snapshot(approved, { pr: pr({ checks: { ci: "success", lint: "pending" } }), config }), { action: "waiting_for_checks", reason: "waiting for required checks: lint" }],
    ["one required check failed", snapshot(approved, { pr: pr({ checks: { ci: "failure", lint: "success" } }), config }), { action: "blocked", reason: "required check failed: ci" }],
    ["one required check missing", snapshot(approved, { pr: pr({ checks: { ci: "success" } }), config }), { action: "blocked", reason: "required check missing: lint" }],
    ["pull request conflicting", snapshot(approved, { pr: pr({ mergeable: "conflicting" }), config }), { action: "blocked", reason: "pull request has conflicts" }],
    [
      "a required check named like an Object.prototype member",
      snapshot(approved, { pr: pr({ checks: {} }), config: { ...config, required_checks: ["constructor"] } }),
      { action: "blocked", reason: "required check missing: constructor" },
    ],
    ["mergeability unknown", snapshot(approved, { pr: pr({ mergeable: "unknown" }), config }), { action: "waiting_for_checks" }],
    [
      "an AC not passed",
      snapshot([handoff(2), test(3), review(4, { ac_results: [{ ac: "AC-1", result: "passed", evidence: "x" }] })], { pr: pr({}), config }),
      { action: "blocked", reason: "reviewer approved but not passed: AC-2" },
    ],
    [
      "an open blocking finding",
      snapshot([handoff(2), test(3, { findings: [{ id: "T-1", blocking: true, summary: "x" }] }), review(4)], { pr: pr({}), config }),
      { action: "blocked", reason: "open blocking findings: T-1" },
    ],
    [
      "a non-blocking finding",
      snapshot([handoff(2), test(3, { findings: [{ id: "T-1", blocking: false, summary: "x" }] }), review(4)], { pr: pr({}), config }),
      { action: "ready_to_merge" },
    ],
    ["reviewer approval older than the tester's", snapshot([handoff(2), review(3), test(4)], { pr: pr({}), config }), { action: "dispatch", role: "reviewer" }],
    ["tester reports blocked", snapshot([handoff(2), test(3, { status: "blocked" })]), { action: "blocked", reason: "tester reported blocked" }],
    ["handoff without a pull request", snapshot([handoff(2)], { pr: null }), { action: "blocked" }],
  ]);
});

describe("AC-8: empty required checks follow the config", () => {
  const approved = [handoff(2), test(3), review(4)];
  const pr = { number: 40, head: BBB, mergeable: "mergeable" as const, checks: {} };
  table([
    ["allow_no_required_checks false", snapshot(approved, { pr, config: { max_correction_rounds: 2, required_checks: [], allow_no_required_checks: false } }), { action: "blocked", reason: "no required checks configured" }],
    ["allow_no_required_checks true", snapshot(approved, { pr, config: { max_correction_rounds: 2, required_checks: [], allow_no_required_checks: true } }), { action: "ready_to_merge" }],
  ]);
});

describe("AC-1: a new head lifts a verifier block", () => {
  const prAt = (head: string) => ({ number: 40, head, mergeable: "mergeable" as const, checks: { ci: "success" as const } });
  table([
    [
      "reviewer blocked for the previous head",
      snapshot([handoff(2), review(3, { head: AAA, status: "blocked" })], { head_transition_at: at(4) }),
      { action: "dispatch", role: "tester", round: 0 },
    ],
    [
      "tester blocked for the previous head",
      snapshot([handoff(2), test(3, { head: AAA, status: "blocked" })], { head_transition_at: at(4) }),
      { action: "dispatch", role: "tester", round: 0 },
    ],
    [
      "the head returned to the blocked SHA after a later transition",
      snapshot([handoff(2), review(3, { head: AAA, status: "blocked" })], { pr: prAt(AAA), head_transition_at: at(5) }),
      { action: "dispatch", role: "tester", round: 0 },
    ],
  ]);
});

describe("AC-2: the same head keeps the block", () => {
  table([
    [
      "reviewer blocked for the current head",
      snapshot([handoff(2), review(3, { status: "blocked" })]),
      { action: "blocked", reason: "reviewer reported blocked" },
    ],
    [
      "tester blocked for the current head",
      snapshot([handoff(2), test(3, { status: "blocked" })]),
      { action: "blocked", reason: "tester reported blocked" },
    ],
  ]);
});

describe("AC-3: a developer block is unchanged", () => {
  table([
    [
      "developer blocked, then the head changes",
      snapshot([handoff(2), handoff(3, 0, { status: "blocked" })], { head_transition_at: at(4) }),
      { action: "blocked", reason: "developer reported blocked" },
    ],
  ]);
});

describe("AC-4: the lifted block does not consume a round", () => {
  it("keeps round 0 and binds the dispatch to the new head", () => {
    const decision = decide(snapshot([handoff(2), review(3, { head: AAA, status: "blocked" })], { head_transition_at: at(4) }));
    expect(decision).toMatchObject({ action: "dispatch", role: "tester", round: 0 });
    if (decision.action !== "dispatch") throw new Error("expected a tester dispatch");
    expect(dispatchKey(decision, BBB, HASH)).toBe(`tester.r0.${BBB}.${HASH}`);
  });
});

describe("decide() is pure", () => {
  it("returns the same decision regardless of the wall clock and does not mutate its input", () => {
    const input = snapshot([test(3), handoff(2)]);
    const copy = structuredClone(input);
    expect(decide(input)).toEqual(decide(copy));
    expect(input).toEqual(copy);
  });
});

describe("JSON Schema export", () => {
  it.each(KINDS)("schemas/gdt-%s.v1.schema.json matches the zod schema", (kind) => {
    const file = new URL(`../schemas/gdt-${kind}.v1.schema.json`, import.meta.url);
    expect(existsSync(file)).toBe(true);
    const exported = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(exported).toMatchObject(z.toJSONSchema(schemas[kind]) as Record<string, unknown>);
  });
});
