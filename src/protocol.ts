import { z } from "zod";
import { type Role, ROLES } from "./config.js";

/** Record kinds; the marker is `[gdt-<kind>:v1]` ... `[/gdt-<kind>:v1]`. */
export const KINDS = ["handoff", "test", "review", "question", "answer", "directive", "round"] as const;
export type Kind = (typeof KINDS)[number];

export const DEVELOPER_STATUSES = ["ready", "awaiting_human", "blocked"] as const;
export const VERIFIER_STATUSES = ["approved", "changes_requested", "awaiting_human", "blocked"] as const;
export const AC_RESULTS = ["passed", "failed", "not_verified"] as const;

const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/name");
const issue = z.int().positive();
const round = z.int().min(0);
const acId = z.string().regex(/^AC-[1-9]\d*$/, "expected AC-<n>");
const sha1 = z.string().regex(/^[0-9a-f]{40}$/, "expected a full 40-character commit SHA");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected a sha256 hex digest");
const text = z.string().trim().min(1);

const core = {
  repository,
  issue,
  round,
  pr_number: z.int().positive().nullable(),
  issue_body_sha256: sha256,
  acceptance_criteria: z.array(acId),
};

const verifier = (role: "tester" | "reviewer", findingPrefix: "T" | "R") =>
  z.strictObject({
    role: z.literal(role),
    status: z.enum(VERIFIER_STATUSES),
    ...core,
    head: sha1,
    ac_results: z.array(z.strictObject({ ac: acId, result: z.enum(AC_RESULTS), evidence: text })),
    findings: z.array(
      z.strictObject({
        id: z.string().regex(new RegExp(`^${findingPrefix}-[1-9]\\d*$`), `expected ${findingPrefix}-<n>`),
        blocking: z.boolean(),
        summary: text,
      }),
    ),
  });

export const schemas = {
  handoff: z.strictObject({
    role: z.literal("developer"),
    status: z.enum(DEVELOPER_STATUSES),
    ...core,
    ac_traceability: z.array(z.strictObject({ ac: acId, files: z.array(text), tests: z.array(text) })),
    assumptions: z.array(text),
    deviations: z.array(text),
  }),
  test: verifier("tester", "T"),
  review: verifier("reviewer", "R"),
  question: z.strictObject({
    role: z.enum(ROLES),
    ...core,
    question_id: z.string().regex(/^Q[1-9]\d*$/, "expected Q<n>"),
    resume_role: z.enum(ROLES),
    question: text,
  }),
  answer: z.strictObject({
    repository,
    issue,
    question_id: z.string().regex(/^Q[1-9]\d*$/, "expected Q<n>"),
    answer: text,
  }),
  directive: z.strictObject({ repository, issue, role: z.enum(ROLES), directive: text }),
  /** Grants the correction round `round` beyond `max_correction_rounds`. */
  round: z.strictObject({ repository, issue, round: z.int().min(1) }),
} as const satisfies Record<Kind, z.ZodType>;

export type RecordData = { [K in Kind]: z.infer<(typeof schemas)[K]> };

/** A validated record with the metadata of the comment it came from. */
export type ProtocolRecord = {
  [K in Kind]: { kind: K; data: RecordData[K]; author: string; created_at: string; comment_id: number };
}[Kind];

export interface Comment {
  id: number;
  author: string;
  /** ISO 8601 timestamp. */
  created_at: string;
  body: string;
}

export interface Diagnostic {
  comment_id: number;
  author: string;
  kind: Kind;
  reason: string;
}

/**
 * An invalid role record, kept so the role's retried turn can be told how its record was rejected
 * (AC-2). It is stored in the workflow state, not derived from the thread, because `gdt retry`
 * clears the in-flight turn before the next dispatch.
 */
export interface InvalidRecord {
  role: Role;
  kind: Kind;
  comment_id: number;
  reason: string;
}

export function marker(kind: Kind, closing = false): string {
  return `[${closing ? "/" : ""}gdt-${kind}:v1]`;
}

/** AC-1: the blocked reason for a turn whose role posted only an invalid record. */
export function invalidRecordReason(role: Role, diagnostic: Diagnostic): string {
  return `${role} posted an invalid record ${marker(diagnostic.kind)} in comment ${diagnostic.comment_id}: ${diagnostic.reason}`;
}

/** True when a blocked reason reports an invalid record, so `gdt retry` can lift it (AC-1). */
export function isInvalidRecordReason(reason: string): boolean {
  return reason.includes(" posted an invalid record ");
}

/** The comment body carrying one record: opening marker, JSON object and closing marker. */
export function formatRecord<K extends Kind>(kind: K, data: RecordData[K]): string {
  return `${marker(kind)}\n${JSON.stringify(data, null, 2)}\n${marker(kind, true)}\n`;
}

const BLOCK = new RegExp(`\\[gdt-(${KINDS.join("|")}):v1\\]([\\s\\S]*?)\\[/gdt-\\1:v1\\]`, "g");

/** Tolerates a Markdown code fence around the JSON object. */
function unfence(content: string): string {
  const fenced = /^\s*```[\w-]*\r?\n([\s\S]*?)\r?\n\s*```\s*$/.exec(content);
  return fenced?.[1] ?? content;
}

function schemaReason(error: z.ZodError): string {
  return error.issues
    .flatMap((issue) =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => `unrecognized key "${[...issue.path, key].join(".")}"`)
        : [`${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`],
    )
    .map((reason) => `schema: ${reason}`)
    .join("; ");
}

/** Extracts every record from `comments`. Invalid blocks are excluded and listed in `diagnostics`. */
export function parseRecords(comments: readonly Comment[]): { records: ProtocolRecord[]; diagnostics: Diagnostic[] } {
  const records: ProtocolRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const comment of comments) {
    for (const match of comment.body.matchAll(BLOCK)) {
      const kind = match[1] as Kind;
      let json: unknown;
      try {
        json = JSON.parse(unfence(match[2] ?? ""));
      } catch {
        diagnostics.push({ comment_id: comment.id, author: comment.author, kind, reason: "invalid JSON" });
        continue;
      }
      const parsed = schemas[kind].safeParse(json);
      if (!parsed.success) {
        diagnostics.push({ comment_id: comment.id, author: comment.author, kind, reason: schemaReason(parsed.error) });
        continue;
      }
      records.push({
        kind,
        data: parsed.data,
        author: comment.author,
        created_at: comment.created_at,
        comment_id: comment.id,
      } as ProtocolRecord);
    }
  }
  return { records, diagnostics };
}
