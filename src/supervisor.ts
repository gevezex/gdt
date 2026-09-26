import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Backend, backendFor } from "./backends/index.js";
import { loadConfig, type ResolvedConfig, type Role, ROLES } from "./config.js";
import { sectionText, validateContract } from "./contract.js";
import { type Decision, decide, openFindings, type PullRequestSnapshot } from "./decision.js";
import { comments, issueSnapshot, pullRequest, repository, viewer } from "./github.js";
import { loadLocale, type Locale } from "./locale.js";
import { notify } from "./notify.js";
import { type Directive, pendingDirectives } from "./prompts.js";
import { parseRecords, type ProtocolRecord } from "./protocol.js";
import {
  acquireLock,
  NOTIFY_STATUSES,
  type Paths,
  paths,
  readJson,
  readState,
  type State,
  type Status,
  writeJsonAtomic,
  writeState,
} from "./state.js";

type Env = Record<string, string | undefined>;

/** Written by a worker when its agent turn has ended. */
export interface TurnResult {
  key: string;
  /** Null when the turn was interrupted (for example by `gdt stop`). */
  exit_code: number | null;
  finished_at: string;
  /** Set when a tester or reviewer turn changed tracked files, the branch or HEAD. */
  violation?: string;
}

/** Written by the supervisor to instruct one worker to run one turn. */
export interface Dispatch {
  key: string;
  issue: number;
  repository: string;
  role: Role;
  round: number;
  pr_number: number | null;
  head: string | null;
  issue_body_sha256: string;
  acceptance_criteria: string[];
  language: string;
  /** Directives for this role posted since its previous dispatch. */
  directives: Directive[];
  dispatched_at: string;
}

export function cliPath(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** One key per role, round, head and contract; a resumed question makes the resumed turn distinct. */
export function dispatchKey(decision: Extract<Decision, { action: "dispatch" }>, head: string | null, bodySha: string): string {
  const parts = [decision.role, `r${decision.round}`, head ?? "no-pr", bodySha];
  if (decision.question_id !== undefined) parts.push(decision.question_id);
  return parts.join(".");
}

function roleOf(record: ProtocolRecord): Role | null {
  switch (record.kind) {
    case "handoff":
      return "developer";
    case "test":
      return "tester";
    case "review":
      return "reviewer";
    case "question":
      return record.data.role;
    default:
      return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function log(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

class Supervisor {
  private trusted: string[] = [];
  private readonly agents: Record<Role, string>;

  constructor(
    private readonly p: Paths,
    private readonly issue: number,
    private readonly config: ResolvedConfig,
    private readonly locale: Locale,
    private readonly env: Env,
    private state: State,
    private readonly backend: Backend,
  ) {
    this.agents = Object.fromEntries(ROLES.map((role) => [role, config.roles[role].agent])) as Record<Role, string>;
  }

  private save(): void {
    writeState(this.p, this.state);
  }

  /** AC-5: the title of a role pane, for example `developer · opencode · RUNNING`. */
  private roleTitle(role: Role, state: string): string {
    return `${role} · ${this.agents[role]} · ${state}`;
  }

  /** Records a status; notifies once when entering a notifying status. */
  private setStatus(status: Status, reason: string, extra: Partial<State> = {}): void {
    if (this.state.status !== status || this.state.reason !== reason) log(`status ${status}${reason === "" ? "" : `: ${reason}`}`);
    Object.assign(this.state, { status, reason }, extra);
    this.backend.setTitle("supervisor", `supervisor · ${status}`);
    if (NOTIFY_STATUSES.includes(status)) {
      if (this.state.notified_status !== status) {
        const used = notify(`gdt #${this.issue}: ${status}`, reason === "" ? status : reason, this.env, log);
        log(`notified via ${used}`);
        this.state.notified_status = status;
      }
    } else {
      this.state.notified_status = null;
    }
    this.save();
  }

  startWorkers(): void {
    this.backend.ensureWorkspace();
    this.backend.setTitle("supervisor", "supervisor · starting");
    for (const role of ROLES) {
      this.backend.setTitle(role, this.roleTitle(role, "WAITING"));
      if (this.backend.alive(this.state.pids.workers[role] ?? -1)) continue;
      this.state.pids.workers[role] = this.backend.spawnPane(role, [process.execPath, cliPath(), "_worker", String(this.issue), role]);
    }
    this.save();
  }

  init(): void {
    this.trusted = [viewer(this.p.root, this.env)];
    this.state.repository = repository(this.p.root, this.env);
  }

  /** One poll. Returns "exit" when the supervisor must stop. */
  tick(now: Date): "continue" | "exit" {
    // `gdt pause` sets this file; `gdt resume` removes it. While it exists no turn is dispatched.
    if (existsSync(this.p.pause)) {
      this.setStatus("paused", "", { role: null });
      return "continue";
    }
    const { body, pullRequests } = issueSnapshot(this.issue, this.p.root, this.env);
    const bodySha = sha256(body);
    const changelog = sectionText(body, this.locale.sections.changelog) ?? "";

    const known = this.state.contract;
    if (known !== null && known.sha256 !== bodySha) {
      if (known.changelog === changelog) {
        this.setStatus("blocked", "issue body changed without a Changelog update");
        return "continue";
      }
      this.state.contract = { sha256: bodySha, changelog };
      this.setStatus("contract_changed", "issue body and Changelog changed; evidence reset");
      return "continue";
    }
    if (known === null) this.state.contract = { sha256: bodySha, changelog };

    const contract = validateContract(body, this.locale, { maxAcceptanceCriteria: this.config.contract.max_acceptance_criteria });
    if (!contract.valid) {
      this.setStatus("blocked", `issue contract invalid: ${contract.errors.join("; ")}`);
      return "continue";
    }

    // A turn in flight: nothing to fetch until its worker has reported.
    const running = this.state.inflight;
    if (running !== null) {
      if (running.violation !== undefined) {
        this.backend.setTitle(running.role, this.roleTitle(running.role, "FAILED"));
        this.setStatus("blocked", running.violation, { role: running.role, round: running.round });
        return "continue";
      }
      if (running.missing) {
        // Also restores the status after a stop and start.
        this.setStatus("blocked", `${running.role} finished without a visible handoff`, { role: running.role, round: running.round });
        return "continue";
      }
      const result = readJson<TurnResult>(this.p.result(running.key));
      if (result === null) {
        this.setStatus("running", `${running.role} turn in progress`, { role: running.role, round: running.round });
        return "continue";
      }
      if (result.violation !== undefined) {
        // A broken role boundary outranks the exit code: the checkout can no longer be trusted.
        running.violation = result.violation;
        this.backend.setTitle(running.role, this.roleTitle(running.role, "FAILED"));
        this.setStatus("blocked", result.violation, { role: running.role, round: running.round, exit_code: result.exit_code });
        return "continue";
      }
      if (result.exit_code !== 0) {
        const reason =
          result.exit_code === null
            ? `${running.role} turn was interrupted`
            : `${running.role} turn failed (exit code ${result.exit_code})`;
        this.backend.setTitle(running.role, this.roleTitle(running.role, "FAILED"));
        this.setStatus("failed", reason, { role: running.role, round: running.round, exit_code: result.exit_code });
        return "exit";
      }
      // AC-5: the turn finished successfully.
      this.backend.setTitle(running.role, this.roleTitle(running.role, "DONE"));
    }

    if (pullRequests.length > 1) {
      this.setStatus("blocked", `more than one open pull request closes #${this.issue}: ${pullRequests.map((n) => `#${n}`).join(", ")}`);
      return "continue";
    }
    const prNumber = pullRequests[0];
    const pr: PullRequestSnapshot | null = prNumber === undefined ? null : pullRequest(prNumber, this.p.root, this.env);
    if (pr !== null) {
      if (this.state.head !== null && this.state.head !== pr.head) {
        this.state.head_transition_at = now.toISOString();
        log(`head ${this.state.head} -> ${pr.head}`);
      }
      this.state.head = pr.head;
    }
    this.state.pr_number = pr?.number ?? null;

    const thread = [...comments(this.state.repository, this.issue, this.p.root, this.env)];
    if (pr !== null) thread.push(...comments(this.state.repository, pr.number, this.p.root, this.env));
    const { records } = parseRecords(thread);
    const trusted = records.filter((r) => this.trusted.includes(r.author));

    const inflight = this.state.inflight;
    if (inflight !== null) {
      const visible = trusted.some((r) => roleOf(r) === inflight.role && r.comment_id > inflight.after_comment_id);
      if (!visible) {
        inflight.checks += 1;
        log(`handoff check ${inflight.checks}/${this.config.workflow.handoff_checks} for ${inflight.key}: not visible`);
        if (inflight.checks >= this.config.workflow.handoff_checks) {
          inflight.missing = true;
          this.setStatus("blocked", `${inflight.role} finished without a visible handoff`);
        } else {
          this.setStatus("running", `waiting for the ${inflight.role} handoff to become visible`, { role: inflight.role, round: inflight.round });
        }
        return "continue";
      }
      this.state.inflight = null;
    }

    const snapshot = {
      repository: this.state.repository,
      issue: this.issue,
      records,
      trusted_authors: this.trusted,
      pr,
      issue_body_sha256: bodySha,
      acceptance_criteria: contract.acceptance_criteria,
      head_transition_at: this.state.head_transition_at,
      config: this.config.workflow,
    };
    this.state.open_findings = openFindings(snapshot);
    const decision = decide(snapshot);

    if (decision.action !== "dispatch") {
      this.setStatus(decision.action, decision.reason, { role: null });
      // AC-7: on completion the workers exit on their own when they see `ready_to_merge`; in herdr
      // mode the supervisor exits too, after printing the completion line as its final output.
      if (decision.action === "ready_to_merge" && this.config.workflow.terminal === "herdr") return "exit";
      return "continue";
    }

    const key = dispatchKey(decision, pr?.head ?? null, bodySha);
    if (this.state.dispatched.includes(key)) {
      this.setStatus("blocked", `${decision.role} already ran for this dispatch without a usable record`, {
        role: decision.role,
        round: decision.round,
      });
      return "continue";
    }

    const afterCommentId = Math.max(0, ...thread.map((c) => c.id));
    const cursor = (this.state.directive_cursor ??= {});
    const directives = pendingDirectives(records, this.trusted, decision.role, cursor[decision.role] ?? 0);
    const dispatch: Dispatch = {
      key,
      issue: this.issue,
      repository: this.state.repository,
      role: decision.role,
      round: decision.round,
      pr_number: pr?.number ?? null,
      head: pr?.head ?? null,
      issue_body_sha256: bodySha,
      acceptance_criteria: contract.acceptance_criteria,
      language: this.config.language,
      directives,
      dispatched_at: now.toISOString(),
    };
    // Dispatch file first: if gdt stop lands in between, the restarted supervisor dispatches the same key
    // again, and the worker's exclusive "started" marker still runs it at most once.
    writeJsonAtomic(this.p.dispatch(decision.role), dispatch);
    this.state.dispatched.push(key);
    cursor[decision.role] = afterCommentId;
    this.state.inflight = {
      key,
      role: decision.role,
      round: decision.round,
      dispatched_at: dispatch.dispatched_at,
      after_comment_id: afterCommentId,
      checks: 0,
      missing: false,
    };
    this.backend.setTitle(decision.role, this.roleTitle(decision.role, "RUNNING"));
    this.setStatus("running", `dispatched ${decision.role}: ${decision.reason}`, { role: decision.role, round: decision.round, exit_code: null });
    log(`dispatched ${key}`);
    return "continue";
  }
}

/** Runs the supervisor loop for `issue` until a failed turn or a signal. Returns the process exit code. */
export async function supervise(root: string, issue: number, env: Env): Promise<number> {
  const p = paths(root, issue, env);
  const holder = acquireLock(p);
  if (holder !== null) {
    log(`Supervisor for #${issue} is already running (pid ${holder})`);
    return 1;
  }
  const release = () => rmSync(p.lock, { force: true });
  process.on("SIGTERM", () => {
    // AC-6: the pane's last output line explains how to resume.
    process.stdout.write(`gdt stopped. Resume with: gdt start ${issue}\n`);
    release();
    process.exit(143);
  });

  const { report } = loadConfig(root, env);
  const state = readState(p);
  if (!report.valid || state === null) {
    log(report.valid ? "no state; run gdt start" : "invalid config; run gdt doctor");
    release();
    return 1;
  }

  state.pids.supervisor = process.pid;
  writeState(p, state);
  const backend = backendFor(report, root, issue, env, p);
  const supervisor = new Supervisor(p, issue, report, loadLocale(report.language), env, state, backend);
  log(`supervisor ${process.pid} for #${issue}, workflow ${state.workflow_id}`);
  try {
    supervisor.init();
    supervisor.startWorkers();
  } catch (err) {
    log(`startup failed: ${err instanceof Error ? err.message : String(err)}`);
    release();
    return 1;
  }

  for (;;) {
    try {
      if (supervisor.tick(new Date()) === "exit") break;
    } catch (err) {
      // GitHub or network trouble: log and try again on the next poll.
      log(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(report.workflow.poll_seconds * 1000);
  }
  // AC-7: the completion line is the pane's final output, so it is written after the last log line.
  if (report.workflow.terminal === "herdr" && readState(p)?.status === "ready_to_merge") {
    process.stdout.write(`Workflow complete: #${issue} is ready to merge. This pane can be closed.\n`);
  } else {
    log("supervisor exiting");
  }
  release();
  return 0;
}
