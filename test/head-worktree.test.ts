import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { headWorktree } from "../src/git.js";
import { buildPrompt, type PromptDispatch } from "../src/prompts.js";
import type { ProtocolRecord } from "../src/protocol.js";
import { alreadyRanReason, type Dispatch } from "../src/supervisor.js";
import { editGithub, gdt, GIT, stateOf, stopWorlds, waitFor, world, type World } from "./world.js";

afterEach(stopWorlds);

const A = "a".repeat(40);
const B = "b".repeat(40);

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(GIT, ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Adds worktree `<root>-7` on branch `feat/7` with one commit more than the main checkout; returns its path and head. */
function addWorktree(root: string): { path: string; head: string } {
  const path = `${root}-7`;
  git(root, "worktree", "add", "-q", "-b", "feat/7", path);
  git(path, "commit", "-q", "--allow-empty", "-m", "feature");
  return { path: realpathSync(path), head: git(path, "rev-parse", "HEAD") };
}

function dispatchFile(w: World, role: string): Dispatch {
  return JSON.parse(readFileSync(join(w.root, ".git/gdt/issue-12/dispatch", `${role}.json`), "utf8")) as Dispatch;
}

/** A world whose pull request 40 has the head of a separate worktree; the main checkout stays on `main`. */
async function worktreeWorld(out: string, reviewer: string, extraFiles: Record<string, string> = {}) {
  const w = world({
    pr: true,
    developer: "gh fake-record 40 handoff\nexit 0\n",
    tester: `pwd -P > "${out}/tester.pwd"\ngh fake-record 40 test\nexit 0\n`,
    extraFiles: { "scripts/reviewer.sh": reviewer, ...extraFiles },
  });
  const wt = addWorktree(w.root);
  await editGithub(w, (data) => {
    data.pulls = { "40": { head: wt.head } };
  });
  return { w, wt };
}

describe("AC-1: a tester or reviewer turn runs in the head worktree", { timeout: 30_000 }, () => {
  it("sets workdir in both dispatch files and starts both agents there", async () => {
    const out = mkdtempSync(join(tmpdir(), "gdt-out-"));
    const { w, wt } = await worktreeWorld(out, `pwd -P > "${out}/reviewer.pwd"\n/bin/sleep 60\n`);
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the reviewer turn", () => {
      try {
        return readFileSync(join(out, "reviewer.pwd"), "utf8") !== "";
      } catch {
        return false;
      }
    });

    expect(dispatchFile(w, "tester").workdir).toBe(wt.path);
    expect(dispatchFile(w, "reviewer").workdir).toBe(wt.path);
    expect(readFileSync(join(out, "tester.pwd"), "utf8").trim()).toBe(wt.path);
    expect(readFileSync(join(out, "reviewer.pwd"), "utf8").trim()).toBe(wt.path);
    rmSync(out, { recursive: true, force: true });
  });
});

describe("AC-2: the boundary check runs in the working directory", { timeout: 30_000 }, () => {
  it("names the file changed in the worktree, not the one changed in the main checkout", async () => {
    const out = mkdtempSync(join(tmpdir(), "gdt-out-"));
    // The reviewer edits src/a.ts in its worktree and scripts/developer.sh in the main checkout.
    const reviewer = 'echo changed >> src/a.ts\necho changed >> "$(git rev-parse --git-common-dir)/../scripts/developer.sh"\nexit 0\n';
    const { w } = await worktreeWorld(out, reviewer, { "src/a.ts": "a\n" });
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("blocked", () => stateOf(w).status === "blocked");

    const json = JSON.parse(gdt(w, "status", "12", "--json").stdout) as { reason: string };
    expect(json.reason).toBe("reviewer changed tracked files: src/a.ts");
    rmSync(out, { recursive: true, force: true });
  });
});

describe("AC-3: without a head worktree elsewhere the main checkout is used", { timeout: 30_000 }, () => {
  it("dispatches the tester in the main checkout when no worktree has the head", async () => {
    const w = world({ pr: true, developer: "gh fake-record 40 handoff\nexit 0\n" });
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the tester dispatch", () => stateOf(w).role === "tester");
    expect(realpathSync(dispatchFile(w, "tester").workdir ?? "")).toBe(realpathSync(w.root));
  });

  it("prefers the main checkout when it and another worktree are both at the head", () => {
    const w = world();
    const wt = addWorktree(w.root);
    git(w.root, "checkout", "-q", "--detach", wt.head);
    expect(headWorktree(w.root, wt.head, w.env)).toBe(w.root);
  });

  it("falls back to the main checkout when no worktree has the head, or its directory is gone", () => {
    const w = world();
    const wt = addWorktree(w.root);
    expect(headWorktree(w.root, B, w.env)).toBe(w.root);
    rmSync(wt.path, { recursive: true, force: true });
    expect(headWorktree(w.root, wt.head, w.env)).toBe(w.root);
  });
});

describe("AC-4: the prompt names the working directory", () => {
  const dispatch: PromptDispatch = {
    repository: "gevezex/demo",
    issue: 12,
    round: 0,
    pr_number: 40,
    head: B,
    issue_body_sha256: "c".repeat(64),
    acceptance_criteria: ["AC-1"],
    language: "en",
    directives: [],
    workdir: "/tmp/x/repo-7",
  };

  it("adds the line to Turn facts", () => {
    const prompt = buildPrompt("reviewer", dispatch, { root: mkdtempSync(join(tmpdir(), "gdt-prompt-")) });
    const facts = prompt.slice(prompt.indexOf("## Turn facts"));
    expect(facts.slice(0, facts.indexOf("\n## ", 1))).toContain("Working directory: /tmp/x/repo-7");
  });

  it.each(["tester", "reviewer"])("roles/%s.md no longer says that all roles share one checkout", (role) => {
    const text = readFileSync(join("roles", `${role}.md`), "utf8").replace(/\s+/g, " ");
    expect(text).not.toContain("All roles share one checkout");
    expect(text).toContain("checkout at the pull request head");
  });
});

/** A trusted record of `kind` for `head`, created at `at`. */
function record(kind: "test" | "review", head: string, at: string): ProtocolRecord {
  const role = kind === "test" ? "tester" : "reviewer";
  return { kind, author: "gevezex", created_at: at, comment_id: 1, data: { role, head } } as unknown as ProtocolRecord;
}

const dispatched: Dispatch = {
  key: "reviewer.r0.k",
  issue: 12,
  repository: "gevezex/demo",
  role: "reviewer",
  round: 0,
  pr_number: 40,
  head: B,
  issue_body_sha256: "c".repeat(64),
  acceptance_criteria: ["AC-1"],
  language: "en",
  directives: [],
  dispatched_at: "2026-10-09T10:00:00.000Z",
  workdir: "/tmp/x/repo",
};

describe("AC-5: a record for another head names the cause", { timeout: 30_000 }, () => {
  it("names both heads and the working directory", () => {
    const reason = alreadyRanReason("reviewer", "reviewer.r0.k", dispatched, [record("review", A, "2026-10-09T10:00:30.000Z")], "/root");
    expect(reason).toBe(`reviewer record is for head ${A}, not the dispatch head ${B}; the turn ran in /tmp/x/repo`);
  });

  it("is the status reason of a workflow whose reviewer posted a record for another head", async () => {
    const w = world({
      pr: true,
      developer: "gh fake-record 40 handoff\nexit 0\n",
      tester: "gh fake-record 40 test\nexit 0\n",
      extraFiles: { "scripts/reviewer.sh": `GDT_HEAD=${A} gh fake-record 40 review\nexit 0\n` },
    });
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("blocked", () => stateOf(w).status === "blocked");

    const workdir = dispatchFile(w, "reviewer").workdir ?? "";
    expect(realpathSync(workdir)).toBe(realpathSync(w.root));
    const json = JSON.parse(gdt(w, "status", "12", "--json").stdout) as { reason: string; next_step: string };
    expect(json.reason).toBe(`reviewer record is for head ${A}, not the dispatch head ${B}; the turn ran in ${workdir}`);
    // `gdt retry` still lifts this block, as it did for the old reason.
    expect(json.next_step).toBe("gdt retry 12");
  });
});

describe("AC-6: without such a record the old reason stays", () => {
  const OLD = "reviewer already ran for this dispatch without a usable record";

  it("keeps the old reason without a record for another head after the dispatch", () => {
    expect(alreadyRanReason("reviewer", "reviewer.r0.k", dispatched, [], "/root")).toBe(OLD);
    expect(alreadyRanReason("reviewer", "reviewer.r0.k", dispatched, [record("review", B, "2026-10-09T10:00:30.000Z")], "/root")).toBe(OLD);
    // Before the dispatch, or by another role, it is not this turn's record.
    expect(alreadyRanReason("reviewer", "reviewer.r0.k", dispatched, [record("review", A, "2026-10-09T09:59:00.000Z")], "/root")).toBe(OLD);
    expect(alreadyRanReason("reviewer", "reviewer.r0.k", dispatched, [record("test", A, "2026-10-09T10:00:30.000Z")], "/root")).toBe(OLD);
  });

  it("keeps the old reason when the dispatch file is for another key", () => {
    expect(alreadyRanReason("reviewer", "reviewer.r1.k", dispatched, [record("review", A, "2026-10-09T10:00:30.000Z")], "/root")).toBe(OLD);
  });
});
