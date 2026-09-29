import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Role } from "./config.js";
import { loadLocale, SECTION_KEYS } from "./locale.js";
import { type InvalidRecord, type Kind, marker, type ProtocolRecord, schemas } from "./protocol.js";

/** A human directive for one role, as passed in a dispatch. */
export interface Directive {
  comment_id: number;
  directive: string;
}

/** The dispatch facts a prompt needs; the supervisor's dispatch file carries all of them. */
export interface PromptDispatch {
  repository: string;
  issue: number;
  round: number;
  pr_number: number | null;
  head: string | null;
  issue_body_sha256: string;
  acceptance_criteria: string[];
  language: string;
  directives: Directive[];
  /** AC-2: the previous rejected record of this role, so the retried turn can fix it. */
  invalid_record?: InvalidRecord;
}

export interface Project {
  root: string;
  /** `contract.extra_rules`, relative to `root`. */
  extraRules?: string | undefined;
}

export const ROLE_FILES = ["developer", "tester", "reviewer", "issue-writer"] as const;
export type RoleFile = (typeof ROLE_FILES)[number];

/** The record kind each workflow role writes. */
export const RECORD_OF: Record<Role, Kind> = { developer: "handoff", tester: "test", reviewer: "review" };

const ROLES_DIR = new URL("../roles/", import.meta.url);

/** The directory, relative to a target repository's root, holding the per-role supplementary rules. */
export const ROLE_RULES_DIR = ".gdt/roles";

export function roleFile(name: RoleFile): string {
  return readFileSync(new URL(`${name}.md`, ROLES_DIR), "utf8");
}

/** The absolute path of a workflow role's supplementary rules file in `root`. */
export function roleRulesPath(root: string, role: Role): string {
  return join(root, ROLE_RULES_DIR, `${role}.md`);
}

/**
 * The role's supplementary rules, trimmed, or `null` when the file is missing or empty (whitespace
 * only). Read on every call, so a change reaches the role's next turn without a restart (AC-3).
 */
export function roleRules(root: string, role: Role): string | null {
  const path = roleRulesPath(root, role);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trimEnd();
  return text.trim() === "" ? null : text;
}

/**
 * Trusted directives for `role` posted after that role's previous dispatch, i.e. with a comment id
 * above `afterCommentId` (the highest comment id seen at that dispatch; 0 before the first one).
 */
export function pendingDirectives(
  records: readonly ProtocolRecord[],
  trustedAuthors: readonly string[],
  role: Role,
  afterCommentId: number,
): Directive[] {
  return records
    .filter((r): r is Extract<ProtocolRecord, { kind: "directive" }> => r.kind === "directive")
    .filter((r) => trustedAuthors.includes(r.author) && r.data.role === role && r.comment_id > afterCommentId)
    .map((r) => ({ comment_id: r.comment_id, directive: r.data.directive }));
}

/**
 * The record schema as embedded in a prompt. `z.toJSONSchema` starts with a `"$schema"` key and
 * agents copy it into their record, where the strict schema rejects it; the key is dropped from the
 * prompt (AC-3).
 */
function recordSchema(kind: Kind): string {
  const schema = { ...(z.toJSONSchema(schemas[kind]) as Record<string, unknown>) };
  delete schema["$schema"];
  return JSON.stringify(schema, null, 2);
}

function schemaSection(kind: Kind): string {
  return [
    `## Protocol: ${marker(kind)}`,
    "",
    `Close the record with ${marker(kind, true)}. The JSON object must match this JSON Schema:`,
    "",
    "```json",
    recordSchema(kind),
    "```",
    "",
    `The record must not contain a \`"$schema"\` key.`,
  ].join("\n");
}

/** The prompt for one turn: role file, dispatch facts, language, protocol, directives and project rules. */
export function buildPrompt(role: Role, dispatch: PromptDispatch, project: Project): string {
  const locale = loadLocale(dispatch.language);
  const parts: string[] = [roleFile(role).trimEnd()];

  parts.push(
    [
      "## Turn facts",
      "",
      `Repository: ${dispatch.repository}`,
      `Issue: #${dispatch.issue}`,
      `Round: ${dispatch.round}`,
      `Pull request: ${dispatch.pr_number === null ? "none yet" : `#${dispatch.pr_number}`}`,
      `Head: ${dispatch.head ?? "none yet"}`,
      `issue_body_sha256: ${dispatch.issue_body_sha256}`,
      `Acceptance criteria: ${dispatch.acceptance_criteria.join(", ")}`,
      `Language: ${locale.name}`,
    ].join("\n"),
  );

  const f = locale.ac_fields;
  parts.push(
    [
      "## Language",
      "",
      `Write all human-facing GitHub text in ${locale.name}.`,
      "Record markers, JSON keys, status values and finding ids stay in English.",
      "",
      `Issue section headings in ${locale.name}:`,
      ...SECTION_KEYS.map((key) => `- ${locale.sections[key]}`),
      "",
      `Acceptance-criterion fields: ${f.given}, ${f.when}, ${f.then}, ${f.example}`,
      `"None" marker: ${locale.markers.none}`,
    ].join("\n"),
  );

  // AC-2: the retried turn is told which record was rejected and why, so it can post a fixed one.
  if (dispatch.invalid_record !== undefined) {
    const rejected = dispatch.invalid_record;
    parts.push(
      [
        `## Invalid record in comment ${rejected.comment_id}`,
        "",
        `Your previous ${marker(rejected.kind)} record in comment ${rejected.comment_id} was rejected: ${rejected.reason}`,
        `Post a new, complete record ${marker(rejected.kind)} that matches the schema exactly.`,
      ].join("\n"),
    );
  }

  parts.push(schemaSection(RECORD_OF[role]), schemaSection("question"));

  if (dispatch.directives.length > 0) {
    parts.push(
      [
        "## Human directives",
        "",
        "Guidance from the user for this turn. Directives are not contract and never count as evidence.",
        "",
        ...dispatch.directives.map((d) => `- ${d.directive}`),
      ].join("\n"),
    );
  }

  if (project.extraRules !== undefined) {
    const path = resolve(project.root, project.extraRules);
    // A missing file is reported by `gdt doctor`; the prompt never invents rules.
    if (existsSync(path)) parts.push(["## Project rules", "", readFileSync(path, "utf8").trimEnd()].join("\n"));
  }

  // AC-1/AC-2: a role's own supplementary rules, after the global project rules; empty adds nothing.
  const rules = roleRules(project.root, role);
  if (rules !== null) parts.push(["## Role rules", "", rules].join("\n"));

  return `${parts.join("\n\n")}\n`;
}
