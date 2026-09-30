// A stand-in for `gh`, backed by one JSON file. Usage: node fake-gh.mjs <github.json> <gh args...>
//
// Test-only extra command, for fake agents:
//   gh fake-record <issue-or-pr> <handoff|test|review|question> [--hidden-reads <n>] [--extra-schema]
// posts a record built from the GDT_* variables the worker sets. A comment with hidden reads stays
// invisible for that many reads of its thread, to model GitHub's delayed visibility. `--extra-schema`
// adds a `"$schema"` key, which the strict record schemas reject (issue #60).
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import process from "node:process";

const [file, ...args] = process.argv.slice(2);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// `gdt stop` kills process groups, so a holder can die inside the lock; its lock is then stale.
function stale(lock) {
  try {
    return !alive(Number(readFileSync(`${lock}/pid`, "utf8")));
  } catch {
    // No pid yet: stale only if the holder died between mkdir and writing it.
    try {
      return Date.now() - statSync(lock).mtimeMs > 1000;
    } catch {
      return false;
    }
  }
}

function withLock(fn) {
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      writeFileSync(`${lock}/pid`, String(process.pid));
      break;
    } catch {
      if (i > 2000) throw new Error("fake gh: lock timeout");
      if (stale(lock)) rmSync(lock, { recursive: true, force: true });
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const result = fn(data);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
    return result;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

class Failure extends Error {}

function fail(message) {
  throw new Failure(message);
}

function record(kind, env, data) {
  const base = {
    repository: env.GDT_REPOSITORY,
    issue: Number(env.GDT_ISSUE),
    round: Number(env.GDT_ROUND),
    pr_number: env.GDT_PR === "" ? null : Number(env.GDT_PR),
    issue_body_sha256: env.GDT_ISSUE_BODY_SHA256,
    acceptance_criteria: data.acceptance_criteria,
  };
  if (kind === "handoff") {
    return { role: "developer", status: "ready", ...base, ac_traceability: [], assumptions: [], deviations: [] };
  }
  if (kind === "question") {
    return { role: env.GDT_ROLE, ...base, question_id: "Q1", resume_role: env.GDT_ROLE, question: "EUR or USD?" };
  }
  if (kind === "test" || kind === "review") {
    const role = kind === "test" ? "tester" : "reviewer";
    const prefix = kind === "test" ? "T" : "R";
    const status = flag("--status") ?? "approved";
    return {
      role,
      status,
      ...base,
      head: env.GDT_HEAD,
      ac_results: (data.acceptance_criteria ?? []).map((ac) => ({ ac, result: status === "approved" ? "passed" : "failed", evidence: "fake" })),
      findings: status === "changes_requested" ? [{ id: `${prefix}-1`, blocking: true, summary: "fake finding" }] : [],
    };
  }
  fail(`fake gh: unknown record kind ${kind}`);
}

const [a, b] = args;
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

try {
  withLock((data) => {
  data.calls = [...(data.calls ?? []), args.join(" ")];
  if (a === "auth" && b === "status") return;
  if (a === "repo" && b === "view") return out({ nameWithOwner: data.repo });
  if (a === "api" && b === "user") return out({ login: data.login });
  if (a === "issue" && b === "view") {
    const issue = data.issues[args[2]];
    if (issue === undefined) fail("GraphQL: Could not resolve to an issue or pull request with the number of " + args[2]);
    return out({ body: issue.body, closedByPullRequestsReferences: (issue.closed_by ?? []).map((number) => ({ number })) });
  }
  if ((a === "issue" || a === "pr") && b === "comment") {
    // `gdt answer`, `gdt steer` and `gdt allow-round` post the body on stdin with --body-file -.
    const body = readStdin();
    const thread = (data.comments[args[2]] ??= []);
    data.next_id = (data.next_id ?? 1000) + 1;
    thread.push({ id: data.next_id, author: data.login, created_at: new Date().toISOString(), body });
    return;
  }
  if (a === "pr" && b === "list") {
    // Open pull requests only, as `gh pr list --state open` returns them; `state` defaults to OPEN.
    const open = Object.entries(data.pulls ?? {}).filter(([, pr]) => (pr.state ?? "OPEN") === "OPEN");
    return out(open.map(([number, pr]) => ({ number: Number(number), body: pr.body ?? "" })));
  }
  if (a === "pr" && b === "view") {
    const pr = data.pulls[args[2]];
    if (pr === undefined) fail(`no pull requests found for ${args[2]}`);
    return out({ number: Number(args[2]), headRefOid: pr.head, mergeable: pr.mergeable ?? "MERGEABLE", statusCheckRollup: pr.checks ?? [] });
  }
  if (a === "api" && args.includes("--paginate")) {
    const path = args.find((arg) => arg.startsWith("repos/"));
    const number = /\/issues\/(\d+)\/comments$/.exec(path)?.[1];
    const thread = (data.comments[number] ??= []);
    const visible = [];
    for (const comment of thread) {
      if ((comment.hidden_reads ?? 0) > 0) comment.hidden_reads -= 1;
      else visible.push({ id: comment.id, user: { login: comment.author }, created_at: comment.created_at, body: comment.body });
    }
    return out([visible]);
  }
  if (a === "fake-record") {
    const kind = args[2];
    const json = record(kind, process.env, data);
    if (args.includes("--extra-schema")) json.$schema = "https://json-schema.org/draft/2020-12/schema";
    const marker = kind;
    const thread = (data.comments[b] ??= []);
    data.next_id = (data.next_id ?? 1000) + 1;
    thread.push({
      id: data.next_id,
      author: flag("--author") ?? data.login,
      created_at: new Date().toISOString(),
      body: `[gdt-${marker}:v1]\n${JSON.stringify(json)}\n[/gdt-${marker}:v1]`,
      hidden_reads: Number(flag("--hidden-reads") ?? 0),
    });
    return;
  }
  fail(`fake gh: unsupported command: ${args.join(" ")}`);
  });
} catch (err) {
  if (!(err instanceof Failure)) throw err;
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
