import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterFor, supportedAgents } from "./agents/index.js";
import { backendFor } from "./backends/index.js";
import { type Agent, loadConfig, ROLES, type Role } from "./config.js";
import { findRepository, which } from "./doctor.js";
import { comments, issueSnapshot, postIssueComment, postPullRequestComment, repository } from "./github.js";
import { formatRecord, parseRecords, type ProtocolRecord } from "./protocol.js";
import { lockHolder, paths, readOverrides, readState, type State, writeJsonAtomic } from "./state.js";
import { describe, fail, ok, type CommandResult } from "./workflow.js";

type Env = Record<string, string | undefined>;

type QuestionRecord = Extract<ProtocolRecord, { kind: "question" }>;
type AnswerRecord = Extract<ProtocolRecord, { kind: "answer" }>;

function rootOf(cwd: string): string {
  return findRepository(cwd) ?? cwd;
}

function ghFailure(err: unknown): CommandResult {
  return fail(`${err instanceof Error ? err.message : String(err)}\n`);
}

/** The role, or a failure result naming the allowed roles. */
function checkRole(role: string): Role | CommandResult {
  return ROLES.includes(role as Role) ? (role as Role) : fail(`Unknown role "${role}"; use developer, tester or reviewer\n`);
}

/** `gdt answer <issue> <question-id> <text>`: posts one `human-answer` for an open question. */
export function answer(issue: number, questionId: string, text: string, cwd: string, env: Env): CommandResult {
  const answerText = text.trim();
  if (answerText === "") return fail(`The answer for ${questionId} is empty.\n`);
  const root = rootOf(cwd);
  try {
    const repo = repository(root, env);
    const thread = comments(repo, issue, root, env);
    for (const pr of issueSnapshot(issue, root, env).pullRequests) thread.push(...comments(repo, pr, root, env));
    const { records } = parseRecords(thread);
    const questions = records.filter(
      (r): r is QuestionRecord => r.kind === "question" && r.data.issue === issue && r.data.question_id === questionId,
    );
    const answers = records.filter(
      (r): r is AnswerRecord => r.kind === "answer" && r.data.issue === issue && r.data.question_id === questionId,
    );
    const open = questions.filter((q) => !answers.some((a) => Date.parse(a.created_at) >= Date.parse(q.created_at)));
    if (open.length === 0) return fail(`No open question ${questionId} on #${issue}\n`);
    postIssueComment(issue, formatRecord("answer", { repository: repo, issue, question_id: questionId, answer: answerText }), root, env);
  } catch (err) {
    return ghFailure(err);
  }
  return ok(`Answered ${questionId} on #${issue}.\n`);
}

/** `gdt steer <issue> --role <role> <text>`: posts one `human-directive` on the workflow channel. */
export function steer(issue: number, role: string, text: string, cwd: string, env: Env): CommandResult {
  const checked = checkRole(role);
  if (typeof checked !== "string") return checked;
  const directive = text.trim();
  if (directive === "") return fail(`The directive for ${checked} is empty.\n`);
  const root = rootOf(cwd);
  try {
    const repo = repository(root, env);
    const pullRequests = issueSnapshot(issue, root, env).pullRequests;
    if (pullRequests.length > 1) {
      return fail(`more than one open pull request closes #${issue}: ${pullRequests.map((n) => `#${n}`).join(", ")}\n`);
    }
    const body = formatRecord("directive", { repository: repo, issue, role: checked, directive });
    const pr = pullRequests[0];
    if (pr === undefined) postIssueComment(issue, body, root, env);
    else postPullRequestComment(pr, body, root, env);
    return ok(`Posted a directive for ${checked} on ${pr === undefined ? `issue #${issue}` : `pull request #${pr}`}.\n`);
  } catch (err) {
    return ghFailure(err);
  }
}

/** `gdt pause <issue>`: no turn is dispatched until `gdt resume`. */
export function pause(issue: number, cwd: string, env: Env): CommandResult {
  const p = paths(rootOf(cwd), issue, env);
  if (readState(p) === null) return fail(`No workflow for #${issue}. Next: gdt start ${issue}\n`);
  mkdirSync(dirname(p.pause), { recursive: true });
  writeFileSync(p.pause, `${new Date().toISOString()}\n`);
  return ok(`Paused #${issue}. Next: gdt resume ${issue}\n`);
}

/** `gdt resume <issue>`: clears the pause; the next decision is dispatched again. */
export function resume(issue: number, cwd: string, env: Env): CommandResult {
  const root = rootOf(cwd);
  const p = paths(root, issue, env);
  const state = readState(p);
  if (state === null) return fail(`No workflow for #${issue}. Next: gdt start ${issue}\n`);
  rmSync(p.pause, { force: true });
  // The supervisor corrects the status on its next poll; report the resumed workflow now.
  const resumed: State = state.status === "paused" ? { ...state, status: "starting", reason: "" } : state;
  return ok(`Resumed #${issue}. Next: ${describe(resumed, lockHolder(p) !== null).next}\n`);
}

/** `gdt allow-round <issue>`: grants one extra correction round when the budget is exhausted. */
export function allowRound(issue: number, cwd: string, env: Env): CommandResult {
  const root = rootOf(cwd);
  const p = paths(root, issue, env);
  const state = readState(p);
  if (state === null) return fail(`No workflow for #${issue}. Next: gdt start ${issue}\n`);
  if (state.status !== "blocked" || !state.reason.startsWith("round budget exhausted")) {
    return fail("allow-round is only valid when the round budget is exhausted\n");
  }
  try {
    const repo = repository(root, env);
    const round = (state.round ?? 0) + 1;
    postIssueComment(issue, formatRecord("round", { repository: repo, issue, round }), root, env);
    return ok(`Granted round ${round} for #${issue}. Next: wait\n`);
  } catch (err) {
    return ghFailure(err);
  }
}

/** `gdt set-agent <issue> <role> <agent>/<model>`: overrides the config for that role from its next turn. */
export function setAgent(issue: number, role: string, spec: string, cwd: string, env: Env): CommandResult {
  const checked = checkRole(role);
  if (typeof checked !== "string") return checked;
  const slash = spec.indexOf("/");
  const agent = slash === -1 ? spec : spec.slice(0, slash);
  const model = slash === -1 ? "" : spec.slice(slash + 1);
  const supported = supportedAgents();
  if (!supported.includes(agent as Agent)) {
    return fail(`Unsupported agent "${agent}"; supported agents: ${supported.join(", ")}\n`);
  }
  if (model.trim() === "") return fail(`Missing model in "${spec}"; use <agent>/<model>\n`);

  const p = paths(rootOf(cwd), issue, env);
  if (readState(p) === null) return fail(`No workflow for #${issue}. Next: gdt start ${issue}\n`);
  writeJsonAtomic(p.overrides, { ...readOverrides(p), [checked]: { agent: agent as Agent, model } });
  // AC-1: the agents overview must name the role's new agent. Best effort: the pane may not exist
  // yet, the terminal may be headless, or herdr may be missing; the override still applies.
  try {
    const { report } = loadConfig(p.root, env);
    if (report.valid && report.workflow.terminal === "herdr") {
      backendFor(report, p.root, issue, env, p).setDisplayAgent(checked, `${checked} · ${agent}`);
    }
  } catch {
    // The override is written; the label is refreshed on the next `gdt start`.
  }
  return ok(`${checked} for #${issue} now uses ${agent} with model ${model} from its next turn.\n`);
}

/** `gdt install-skill`: copies `skill/SKILL.md` into every detected harness; idempotent. */
export function installSkill(env: Env): CommandResult {
  const source = fileURLToPath(new URL("../skill/SKILL.md", import.meta.url));
  let text: string;
  try {
    text = readFileSync(source, "utf8");
  } catch (err) {
    return fail(`Cannot read ${source}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  const home = env.HOME ?? homedir();
  const lines: string[] = [];
  for (const agent of supportedAgents()) {
    const adapter = adapterFor(agent);
    if (adapter === undefined) continue;
    if (which(adapter.binary, env) === null) {
      lines.push(`skipped: ${agent} not found`);
      continue;
    }
    const dir = adapter.skillDir().replace(/^~/, home);
    const destination = join(dir, "SKILL.md");
    if (existsSync(destination) && readFileSync(destination, "utf8") === text) {
      lines.push(`up to date  ${destination}`);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(destination, text);
    lines.push(`installed  ${destination}`);
  }
  return ok(`${lines.join("\n")}\n`);
}
