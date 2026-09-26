import type { Role } from "./config.js";
import type { ProtocolRecord, RecordData } from "./protocol.js";

export const CHECK_STATES = ["success", "pending", "failure"] as const;
export type CheckState = (typeof CHECK_STATES)[number];

export interface PullRequestSnapshot {
  number: number;
  head: string;
  mergeable: "mergeable" | "conflicting" | "unknown";
  /** State per check name, as normalised by the supervisor. */
  checks: Record<string, CheckState>;
}

/** Everything `decide()` needs. All times are ISO 8601 strings supplied by the caller. */
export interface Snapshot {
  repository: string;
  issue: number;
  records: readonly ProtocolRecord[];
  trusted_authors: readonly string[];
  /** Null before the workflow pull request exists. */
  pr: PullRequestSnapshot | null;
  issue_body_sha256: string;
  acceptance_criteria: readonly string[];
  /** When the supervisor last saw the PR head change; null if it never changed. */
  head_transition_at: string | null;
  config: {
    max_correction_rounds: number;
    required_checks: readonly string[];
    allow_no_required_checks: boolean;
  };
}

export type Decision =
  | { action: "dispatch"; role: Role; round: number; reason: string; /** Set when resuming after this answered question. */ question_id?: string }
  | { action: "awaiting_human" | "waiting_for_checks" | "ready_to_merge" | "blocked"; reason: string };

type Of<K extends ProtocolRecord["kind"]> = Extract<ProtocolRecord, { kind: K }>;
type RoleRecord = Of<"handoff"> | Of<"test"> | Of<"review">;
type Verifier = Of<"test"> | Of<"review">;

const ROLE_OF = { handoff: "developer", test: "tester", review: "reviewer" } as const;

function time(iso: string): number {
  return Date.parse(iso);
}

function isRoleRecord(record: ProtocolRecord): record is RoleRecord {
  return record.kind === "handoff" || record.kind === "test" || record.kind === "review";
}

/** Keeps records that are trusted and belong to this issue and, where they carry one, the current body hash. */
function relevant(snapshot: Snapshot): ProtocolRecord[] {
  const trusted = new Set(snapshot.trusted_authors);
  return snapshot.records
    .filter((record) => trusted.has(record.author))
    .filter((record) => record.data.repository === snapshot.repository && record.data.issue === snapshot.issue)
    .filter((record) => !("issue_body_sha256" in record.data) || record.data.issue_body_sha256 === snapshot.issue_body_sha256)
    .toSorted((a, b) => time(a.created_at) - time(b.created_at) || a.comment_id - b.comment_id);
}

function latest<T extends ProtocolRecord>(records: readonly ProtocolRecord[], match: (r: ProtocolRecord) => r is T): T | undefined {
  return records.filter(match).at(-1);
}

function questionDecision(records: readonly ProtocolRecord[]): Decision | undefined {
  const questions = records.filter((r): r is Of<"question"> => r.kind === "question");
  const answers = records.filter((r): r is Of<"answer"> => r.kind === "answer");
  const answerOf = (q: Of<"question">) =>
    answers.find((a) => a.data.question_id === q.data.question_id && time(a.created_at) >= time(q.created_at));

  const open = questions.filter((q) => answerOf(q) === undefined);
  if (open.length > 0) {
    return { action: "awaiting_human", reason: `waiting for an answer to ${open.map((q) => q.data.question_id).join(", ")}` };
  }

  // The most recently answered question resumes its role, unless that role has published since the answer.
  const answered = questions.map((q) => ({ q, a: answerOf(q) as Of<"answer"> })).sort((x, y) => time(x.a.created_at) - time(y.a.created_at));
  const last = answered.at(-1);
  if (last === undefined) return undefined;
  const role = last.q.data.resume_role;
  const resumed = records.some((r) => isRoleRecord(r) && ROLE_OF[r.kind] === role && time(r.created_at) > time(last.a.created_at));
  if (resumed) return undefined;
  return {
    action: "dispatch",
    role,
    round: last.q.data.round,
    reason: `${last.q.data.question_id} answered; resuming ${role}`,
    question_id: last.q.data.question_id,
  };
}

function correction(snapshot: Snapshot, records: readonly ProtocolRecord[], record: Verifier, round: number): Decision {
  // A verifier record with a stale or wrong round must not reset the budget.
  const next = Math.max(round, record.data.round) + 1;
  const granted = records.some((r) => r.kind === "round" && r.data.round === next);
  const open = record.data.findings.map((f) => f.id);
  if (next > snapshot.config.max_correction_rounds && !granted) {
    return { action: "blocked", reason: `round budget exhausted; open findings: ${open.length > 0 ? open.join(", ") : "none"}` };
  }
  return {
    action: "dispatch",
    role: "developer",
    round: next,
    reason: `${ROLE_OF[record.kind]} requested changes${open.length > 0 ? `: ${open.join(", ")}` : ""}`,
  };
}

function gates(snapshot: Snapshot, pr: PullRequestSnapshot, approvals: readonly Verifier[]): Decision {
  for (const record of approvals) {
    const role = ROLE_OF[record.kind];
    const results = new Map(record.data.ac_results.map((r) => [r.ac, r.result]));
    const unpassed = snapshot.acceptance_criteria.filter((ac) => results.get(ac) !== "passed");
    if (unpassed.length > 0) return { action: "blocked", reason: `${role} approved but not passed: ${unpassed.join(", ")}` };
    const blocking = record.data.findings.filter((f) => f.blocking).map((f) => f.id);
    if (blocking.length > 0) return { action: "blocked", reason: `open blocking findings: ${blocking.join(", ")}` };
  }

  if (pr.mergeable === "conflicting") return { action: "blocked", reason: "pull request has conflicts" };
  if (pr.mergeable === "unknown") return { action: "waiting_for_checks", reason: "mergeability not yet known" };

  const required = snapshot.config.required_checks;
  if (required.length === 0) {
    return snapshot.config.allow_no_required_checks
      ? { action: "ready_to_merge", reason: "approved; no required checks configured (allowed by config)" }
      : { action: "blocked", reason: "no required checks configured" };
  }
  const state = (name: string): CheckState | undefined => (Object.hasOwn(pr.checks, name) ? pr.checks[name] : undefined);
  const missing = required.filter((name) => state(name) === undefined);
  if (missing.length > 0) return { action: "blocked", reason: `required check missing: ${missing.join(", ")}` };
  const failed = required.filter((name) => state(name) === "failure");
  if (failed.length > 0) return { action: "blocked", reason: `required check failed: ${failed.join(", ")}` };
  const pending = required.filter((name) => state(name) === "pending");
  if (pending.length > 0) return { action: "waiting_for_checks", reason: `waiting for required checks: ${pending.join(", ")}` };

  return { action: "ready_to_merge", reason: "all gates passed" };
}

/** Evidence for the current head, created after both the head transition and `after`. */
function evidence<K extends "test" | "review">(
  records: readonly ProtocolRecord[],
  kind: K,
  pr: PullRequestSnapshot,
  after: number,
): Of<K> | undefined {
  return latest(records, (r): r is Of<K> => r.kind === kind && (r.data as RecordData[K]).head === pr.head && time(r.created_at) > after);
}

/** A verifier record that is not an approval ends the chain here. */
function verdict(snapshot: Snapshot, records: readonly ProtocolRecord[], record: Verifier, round: number): Decision | undefined {
  const role = ROLE_OF[record.kind];
  switch (record.data.status) {
    case "approved":
      return undefined;
    case "changes_requested":
      return correction(snapshot, records, record, round);
    case "awaiting_human":
      return { action: "awaiting_human", reason: `${role} is waiting for a human decision` };
    case "blocked":
      return { action: "blocked", reason: `${role} reported blocked` };
  }
}

/** The pure decision engine: no I/O, no clock. */
export function decide(snapshot: Snapshot): Decision {
  const records = relevant(snapshot);

  const question = questionDecision(records);
  if (question !== undefined) return question;

  const last = latest(records, isRoleRecord);
  if (last !== undefined && last.data.status === "blocked") {
    return { action: "blocked", reason: `${ROLE_OF[last.kind]} reported blocked` };
  }
  if (last !== undefined && last.data.status === "awaiting_human") {
    return { action: "awaiting_human", reason: `${ROLE_OF[last.kind]} is waiting for a human decision` };
  }

  const handoff = latest(records, (r): r is Of<"handoff"> => r.kind === "handoff" && r.data.status === "ready");
  if (handoff === undefined) return { action: "dispatch", role: "developer", round: 0, reason: "no developer handoff yet" };
  const round = handoff.data.round;

  const pr = snapshot.pr;
  if (pr === null) return { action: "blocked", reason: "developer handoff without a pull request" };

  const transition = snapshot.head_transition_at === null ? Number.NEGATIVE_INFINITY : time(snapshot.head_transition_at);
  const after = Math.max(transition, time(handoff.created_at));

  const test = evidence(records, "test", pr, after);
  if (test === undefined) return { action: "dispatch", role: "tester", round, reason: `no tester evidence for head ${pr.head}` };
  const afterTest = verdict(snapshot, records, test, round);
  if (afterTest !== undefined) return afterTest;

  const review = evidence(records, "review", pr, Math.max(after, time(test.created_at)));
  if (review === undefined) return { action: "dispatch", role: "reviewer", round, reason: `no reviewer evidence for head ${pr.head}` };
  const afterReview = verdict(snapshot, records, review, round);
  if (afterReview !== undefined) return afterReview;

  return gates(snapshot, pr, [test, review]);
}
