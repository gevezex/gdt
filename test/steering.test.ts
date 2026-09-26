import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { paths, writeState, type State } from "../src/state.js";
import { EXAMPLE_CONFIG, fakePath, gdt as gdtInProcess, tempRepo } from "./helpers.js";
import { editGithub, type FakeComment, gdt, lines, sleep, stateOf, stopWorlds, waitFor, world } from "./world.js";

afterEach(stopWorlds);

/** Runs a command in-process with a custom PATH and HOME. */
function runInProcess(argv: string[], cwd: string, env: Record<string, string>): { code: number | undefined; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = run(argv, { cwd, env, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { code, stdout, stderr };
}

function recordBody(kind: string, data: Record<string, unknown>): string {
  return `[gdt-${kind}:v1]\n${JSON.stringify(data)}\n[/gdt-${kind}:v1]`;
}

function questionComment(id: number, questionId: string): FakeComment {
  return {
    id,
    author: "gevezex",
    created_at: new Date().toISOString(),
    body: recordBody("question", {
      role: "developer",
      repository: "gevezex/demo",
      issue: 12,
      round: 1,
      pr_number: null,
      issue_body_sha256: "a".repeat(64),
      acceptance_criteria: ["AC-1", "AC-2"],
      question_id: questionId,
      resume_role: "developer",
      question: "EUR or USD?",
    }),
  };
}

function baseState(over: Partial<State> = {}): State {
  return {
    version: 1,
    issue: 12,
    workflow_id: "a1b2c3",
    status: "running",
    reason: "",
    role: null,
    round: null,
    exit_code: null,
    repository: "gevezex/demo",
    pr_number: null,
    head: null,
    head_transition_at: null,
    contract: null,
    dispatched: [],
    inflight: null,
    notified_status: null,
    pids: { supervisor: null, workers: {} },
    updated_at: "",
    ...over,
  };
}

describe("AC-1: status --json is complete", () => {
  it("reports issue, status, role, round, max_rounds, pr_number, open_findings and next_step", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    const p = paths(root, 12, { PATH: process.env.PATH ?? "" });
    writeState(p, baseState({ status: "running", role: "tester", round: 1, pr_number: 40 }));
    writeFileSync(p.lock, `${process.pid}\n`);

    const result = gdtInProcess(["status", "12", "--json"], root, fakePath());
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      issue: 12,
      status: "running",
      role: "tester",
      round: 1,
      max_rounds: 2,
      pr_number: 40,
      open_findings: [],
      next_step: "wait",
    });
  });
});

describe("AC-2: answer posts only for an open question", () => {
  it("posts one [gdt-answer:v1] issue comment with the exact text", async () => {
    const w = world();
    await editGithub(w, (data) => {
      data.comments["12"] = [questionComment(10, "Q1")];
    });

    const result = gdt(w, "answer", "12", "Q1", "Gebruik EUR");
    expect(result.code).toBe(0);
    const posted = JSON.parse(readFileSync(w.github, "utf8")).comments["12"] as FakeComment[];
    const answers = posted.filter((c) => c.body.includes("[gdt-answer:v1]"));
    expect(answers).toHaveLength(1);
    expect(answers[0]?.body).toContain('"answer": "Gebruik EUR"');
  });

  it("refuses an unknown id with exit 1 and posts nothing", async () => {
    const w = world();
    await editGithub(w, (data) => {
      data.comments["12"] = [questionComment(10, "Q1")];
    });
    const before = (JSON.parse(readFileSync(w.github, "utf8")).comments["12"] as FakeComment[]).length;

    const result = gdt(w, "answer", "12", "Q9", "x");
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("No open question Q9 on #12\n");
    expect((JSON.parse(readFileSync(w.github, "utf8")).comments["12"] as FakeComment[]).length).toBe(before);
  });

  it("treats an already answered question as not open", async () => {
    const w = world();
    const answer = { repository: "gevezex/demo", issue: 12, question_id: "Q1", answer: "EUR" };
    await editGithub(w, (data) => {
      data.comments["12"] = [questionComment(10, "Q1"), { id: 11, author: "gevezex", created_at: new Date().toISOString(), body: recordBody("answer", answer) }];
    });
    const result = gdt(w, "answer", "12", "Q1", "USD");
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("No open question Q1 on #12\n");
  });
});

describe("AC-3: steer posts a directive on the workflow channel", () => {
  it("posts on the workflow pull request when one exists", () => {
    const w = world({ pr: true });
    expect(gdt(w, "steer", "12", "--role", "developer", "Reuse parseAmount").code).toBe(0);
    const comments = JSON.parse(readFileSync(w.github, "utf8")).comments["40"] as FakeComment[];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("[gdt-directive:v1]");
    expect(comments[0]?.body).toContain('"role": "developer"');
    expect(comments[0]?.body).toContain('"directive": "Reuse parseAmount"');
  });

  it("posts on the issue before a pull request exists", () => {
    const w = world();
    expect(gdt(w, "steer", "12", "--role", "tester", "Test negative amounts").code).toBe(0);
    const comments = (JSON.parse(readFileSync(w.github, "utf8")).comments["12"] ?? []) as FakeComment[];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("[gdt-directive:v1]");
  });

  it("rejects an unknown role with exit 1", () => {
    const w = world();
    const result = gdt(w, "steer", "12", "--role", "deployer", "x");
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('Unknown role "deployer"; use developer, tester or reviewer\n');
  });
});

describe("AC-4: pause and resume control dispatching", { timeout: 30_000 }, () => {
  it("dispatches nothing while paused and resumes on gdt resume", async () => {
    const w = world({ developer: "/bin/sleep 1.5\ngh fake-record 40 handoff\nexit 0\n", pr: true });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the developer dispatch", () => stateOf(w).dispatched.length === 1);

    expect(gdt(w, "pause", "12").code).toBe(0);
    expect(gdt(w, "status", "12").stdout).toBe("paused. Next: gdt resume 12\n");

    // The developer handoff becomes visible while paused: the tester must not be dispatched.
    await sleep(2200);
    expect(stateOf(w).dispatched).toHaveLength(1);
    expect(gdt(w, "status", "12").stdout).toBe("paused. Next: gdt resume 12\n");

    expect(gdt(w, "resume", "12").code).toBe(0);
    await waitFor("the tester dispatch", () => stateOf(w).role === "tester");
    expect(stateOf(w).dispatched).toHaveLength(2);
  });
});

describe("AC-5: allow-round only when the budget is exhausted", { timeout: 60_000 }, () => {
  it("posts a round grant and the developer is dispatched when the budget is exhausted", async () => {
    const w = world({
      developer: "gh fake-record 40 handoff\nexit 0\n",
      tester: "gh fake-record 40 test --status changes_requested\nexit 0\n",
      pr: true,
    });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor(
      "the round budget to be exhausted",
      () => stateOf(w).status === "blocked" && stateOf(w).reason.startsWith("round budget exhausted"),
    );
    expect(stateOf(w).round).toBe(2);

    expect(gdt(w, "allow-round", "12").code).toBe(0);
    const grants = ((JSON.parse(readFileSync(w.github, "utf8")).comments["12"] ?? []) as FakeComment[]).filter((c) =>
      c.body.includes("[gdt-round:v1]"),
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]?.body).toContain('"round": 3');

    await waitFor("the extra developer round", () => stateOf(w).role === "developer" && stateOf(w).round === 3);
  });

  it("refuses in any other status with exit 1 and posts nothing", () => {
    const root = tempRepo({ ".gdt/config.toml": EXAMPLE_CONFIG });
    const p = paths(root, 12, { PATH: process.env.PATH ?? "" });
    writeState(p, baseState({ status: "running", role: "tester", round: 0 }));

    const result = gdtInProcess(["allow-round", "12"], root, fakePath());
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("allow-round is only valid when the round budget is exhausted\n");
  });
});

describe("AC-6: set-agent changes the next turn", { timeout: 30_000 }, () => {
  it("stores the override, shows it in status --json and runs the new agent next", async () => {
    const w = world({ developer: "/bin/sleep 1.5\ngh fake-record 40 handoff\nexit 0\n", pr: true });
    const argsFile = join(w.bin, "claude-args");
    writeFileSync(join(w.bin, "claude"), `#!/bin/sh\necho "$@" >> "${argsFile}"\nexit 0\n`);
    chmodSync(join(w.bin, "claude"), 0o755);

    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the developer dispatch", () => stateOf(w).dispatched.length === 1);

    expect(gdt(w, "set-agent", "12", "tester", "claude/claude-sonnet-5").code).toBe(0);
    const status = JSON.parse(gdt(w, "status", "12", "--json").stdout);
    expect(status.overrides).toEqual({ tester: { agent: "claude", model: "claude-sonnet-5" } });

    await waitFor("the tester turn with the override", () => lines(argsFile).length >= 1);
    expect(lines(argsFile).join(" ")).toContain("--model claude-sonnet-5");
  });

  it("rejects an unsupported agent with exit 1 and names the supported agents", () => {
    const w = world();
    const result = gdt(w, "set-agent", "12", "tester", "foo/bar");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unsupported agent \"foo\"");
    for (const agent of ["claude", "codex", "opencode"]) expect(result.stderr).toContain(agent);
  });
});

describe("AC-7: install-skill is idempotent", () => {
  it("copies into detected harnesses, lists paths, and reports up to date on a second run", () => {
    const home = mkdtempSync(join(tmpdir(), "gdt-home-"));
    const bin = mkdtempSync(join(tmpdir(), "gdt-bin-"));
    for (const agent of ["claude", "codex"]) {
      writeFileSync(join(bin, agent), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, agent), 0o755);
    }
    const env = { PATH: bin, HOME: home };

    const first = runInProcess(["install-skill"], home, env);
    expect(first.code).toBe(0);
    const claudeSkill = join(home, ".claude/skills/gdt/SKILL.md");
    const codexSkill = join(home, ".codex/skills/gdt/SKILL.md");
    expect(existsSync(claudeSkill)).toBe(true);
    expect(existsSync(codexSkill)).toBe(true);
    expect(readFileSync(claudeSkill, "utf8")).toBe(readFileSync("skill/SKILL.md", "utf8"));
    expect(first.stdout).toContain(claudeSkill);
    expect(first.stdout).toContain(codexSkill);
    expect(first.stdout).toContain("skipped: opencode not found");

    const second = runInProcess(["install-skill"], home, env);
    expect(second.code).toBe(0);
    expect(second.stdout.match(/up to date/g)).toHaveLength(2);
    expect(second.stdout).toContain("skipped: opencode not found");
  });
});

describe("non-functional: retry and stop print the same next_step as status", { timeout: 30_000 }, () => {
  it("matches status after a failed turn and after a retry", async () => {
    const w = world({ developer: "exit 3\n" });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("failed", () => stateOf(w).status === "failed");

    const nextOf = (text: string) => text.slice(text.indexOf("Next: ") + "Next: ".length).trim();
    const failedNext = nextOf(gdt(w, "status", "12").stdout);
    expect(failedNext).toBe("gdt retry 12");
    const stopped = gdt(w, "stop", "12");
    expect(stopped.code).toBe(0);
    expect(nextOf(stopped.stdout)).toBe(failedNext);

    const retried = gdt(w, "retry", "12");
    expect(retried.code).toBe(0);
    expect(nextOf(retried.stdout)).toBe(nextOf(gdt(w, "status", "12").stdout));
    expect(nextOf(retried.stdout)).toBe("gdt start 12");
    expect(stateOf(w).status).toBe("stopped");
    expect(stateOf(w).dispatched).toEqual([]);
  });
});

describe("AC-8: the operator skill carries the rules", () => {
  const text = readFileSync("skill/SKILL.md", "utf8");

  it("is at most 60 lines and contains the four operator rules", () => {
    expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(60);
    // Design section 2.2, rules 1 to 4.
    expect(text).toContain("never runs as a child of the operator");
    expect(text).toContain("No polling");
    expect(text).toContain("Never post an answer or directive the user did not state or confirm.");
    expect(text).toContain("Hands off the working tree");
  });

  it("tells the operator to reply in the language the user writes in", () => {
    expect(text).toContain("Reply in the language the user writes in.");
  });
});
