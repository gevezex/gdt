import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Role } from "../src/config.js";
import type { DoctorReport } from "../src/doctor.js";
import { checkout } from "../src/git.js";
import { loadLocale, SECTION_KEYS } from "../src/locale.js";
import { buildPrompt, pendingDirectives, type PromptDispatch, ROLE_FILES, roleFile } from "../src/prompts.js";
import { DEVELOPER_STATUSES, type ProtocolRecord, VERIFIER_STATUSES } from "../src/protocol.js";
import { boundaryViolation } from "../src/worker.js";
import { EXAMPLE_CONFIG, fakePath, gdt as gdtInProcess, tempRepo } from "./helpers.js";
import { BODY, editGithub, GIT, lines, stateOf, stopWorlds, waitFor, world, gdt } from "./world.js";

afterEach(stopWorlds);

const dispatch = (over: Partial<PromptDispatch> = {}): PromptDispatch => ({
  repository: "gevezex/demo",
  issue: 12,
  round: 1,
  pr_number: 40,
  head: "b".repeat(40),
  issue_body_sha256: "a".repeat(64),
  acceptance_criteria: ["AC-1", "AC-2"],
  language: "en",
  directives: [],
  ...over,
});

const project = { root: tmpdir() };

describe("AC-1: a prompt contains only its own role file", () => {
  it.each(["developer", "tester", "reviewer"] as const)("the %s prompt has its file and nothing from the others", (role) => {
    const prompt = buildPrompt(role, dispatch(), project);
    expect(prompt).toContain(roleFile(role).trimEnd());
    const own = roleFile(role);
    for (const other of ROLE_FILES.filter((name) => name !== role)) {
      const unique = roleFile(other)
        .split("\n")
        .filter((line) => line.trim().length > 20 && !own.includes(line.trim()));
      expect(unique.length).toBeGreaterThan(0);
      for (const line of unique) expect(prompt).not.toContain(line);
    }
  });

  it("does not contain the other role headings", () => {
    const prompt = buildPrompt("tester", dispatch(), project);
    expect(prompt).toContain("# Role: tester");
    for (const other of ["# Role: developer", "# Role: reviewer", "# Role: issue writer"]) expect(prompt).not.toContain(other);
  });
});

describe("AC-2: dispatch facts and language are included", () => {
  it("includes each fact, the language sentence and the nl headings and labels", () => {
    const prompt = buildPrompt("developer", dispatch({ language: "nl" }), project);
    for (const fact of ["Issue: #12", "Round: 1", "Pull request: #40", `issue_body_sha256: ${"a".repeat(64)}`, "Acceptance criteria: AC-1, AC-2"]) {
      expect(prompt).toContain(fact);
    }
    expect(prompt).toContain("Write all human-facing GitHub text in Dutch.");
    const nl = loadLocale("nl");
    for (const key of SECTION_KEYS) expect(prompt).toContain(`- ${nl.sections[key]}`);
    expect(prompt).toContain("Acceptatiecriteria");
    expect(prompt).toContain("Acceptance-criterion fields: Gegeven, Wanneer, Dan, Voorbeeld");
  });

  it("says when there is no pull request yet and names the role's record schema", () => {
    const prompt = buildPrompt("developer", dispatch({ pr_number: null, head: null, round: 0 }), project);
    expect(prompt).toContain("Pull request: none yet");
    expect(prompt).toContain("Write all human-facing GitHub text in English.");
    expect(prompt).toContain("## Protocol: [gdt-handoff:v1]");
    expect(prompt).toContain("## Protocol: [gdt-question:v1]");
    expect(prompt).not.toContain("[gdt-test:v1] must match");
  });
});

describe("AC-3: project rules are appended", () => {
  it("appends the file under Project rules", () => {
    const root = tempRepo({ ".gdt/rules.md": "A local match is no proof of external processing.\n" });
    const prompt = buildPrompt("reviewer", dispatch(), { root, extraRules: ".gdt/rules.md" });
    expect(prompt).toContain("## Project rules\n\nA local match is no proof of external processing.\n");
  });

  it("reports a missing file in doctor", () => {
    const config = EXAMPLE_CONFIG.replace("[contract]\n", '[contract]\nextra_rules = ".gdt/rules.md"\n');
    const result = gdtInProcess(["doctor", "--json"], tempRepo({ ".gdt/config.toml": config }), fakePath());
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.findings).toContainEqual(
      expect.objectContaining({ level: "error", message: "contract.extra_rules: .gdt/rules.md not found" }),
    );
    expect(result.code).toBe(1);
  });

  it("adds no Project rules section without the key", () => {
    expect(buildPrompt("tester", dispatch(), project)).not.toContain("## Project rules");
  });
});

function directive(id: number, role: Role, text: string, author = "gevezex"): ProtocolRecord {
  return {
    kind: "directive",
    data: { repository: "gevezex/demo", issue: 12, role, directive: text },
    author,
    created_at: new Date(Date.UTC(2026, 8, 26, 10, id)).toISOString(),
    comment_id: id,
  };
}

function directiveComment(id: number, role: Role, text: string) {
  const data = { repository: "gevezex/demo", issue: 12, role, directive: text };
  return { id, author: "gevezex", created_at: new Date().toISOString(), body: `[gdt-directive:v1]\n${JSON.stringify(data)}\n[/gdt-directive:v1]` };
}

describe("AC-4: directives reach only their role, once", () => {
  it("selects the role's directives posted after its previous dispatch", () => {
    const records = [
      directive(10, "developer", "Reuse parseAmount"),
      directive(11, "tester", "Test negative amounts"),
      directive(12, "developer", "Ignore me", "mallory"),
    ];
    const first = pendingDirectives(records, ["gevezex"], "developer", 0);
    expect(first).toEqual([{ comment_id: 10, directive: "Reuse parseAmount" }]);
    const prompt = buildPrompt("developer", dispatch({ directives: first }), project);
    expect(prompt).toContain("## Human directives");
    expect(prompt).toContain("- Reuse parseAmount");
    expect(prompt).not.toContain("Test negative amounts");
    expect(prompt).not.toContain("Ignore me");

    // The first dispatch saw comments up to id 20; the next one gets nothing new.
    const second = pendingDirectives(records, ["gevezex"], "developer", 20);
    expect(second).toEqual([]);
    expect(buildPrompt("developer", dispatch({ directives: second }), project)).not.toContain("Reuse parseAmount");
  });

  it("puts a directive in exactly one developer prompt across two dispatches", { timeout: 30_000 }, async () => {
    const log = join(tmpdir(), `gdt-prompts-${process.pid}-${Date.now()}`);
    const w = world({ developer: `/bin/cat "$GDT_PROMPT_FILE" >> "${log}"\ngh fake-record 12 question\nexit 0\n` });
    await editGithub(w, (data) => {
      data.comments["12"] = [directiveComment(5, "developer", "Reuse parseAmount"), directiveComment(6, "tester", "Test negative amounts")];
    });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("the first question", () => stateOf(w).status === "awaiting_human");

    await editGithub(w, (data) => {
      const answer = { repository: "gevezex/demo", issue: 12, question_id: "Q1", answer: "EUR" };
      data.next_id = (data.next_id ?? 1000) + 1;
      data.comments["12"]?.push({
        id: data.next_id,
        author: "gevezex",
        created_at: new Date().toISOString(),
        body: `[gdt-answer:v1]\n${JSON.stringify(answer)}\n[/gdt-answer:v1]`,
      });
    });
    await waitFor("the second developer dispatch", () => stateOf(w).dispatched.length === 2);
    await waitFor("the second prompt", () => lines(log).filter((l) => l === "# Role: developer").length === 2);

    const prompts = readFileSync(log, "utf8");
    expect(prompts.match(/Reuse parseAmount/g)).toHaveLength(1);
    expect(prompts).not.toContain("Test negative amounts");
  });
});

describe("AC-5: tester and reviewer may not change the checkout", () => {
  function repo() {
    const root = tempRepo({ "src/a.ts": "export {};\n" });
    const git = (...args: string[]) => spawnSync(GIT, ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root });
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    return { root, git, env: { PATH: process.env.PATH ?? "" } };
  }

  it("names the role and the changed tracked paths", () => {
    const { root, env } = repo();
    const before = checkout(root, env);
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
    expect(boundaryViolation("tester", before, root, env)).toBe("tester changed tracked files: src/a.ts");
    expect(boundaryViolation("reviewer", before, root, env)).toBe("reviewer changed tracked files: src/a.ts");
    expect(boundaryViolation("developer", before, root, env)).toBeUndefined();
  });

  it("ignores untracked scratch files", () => {
    const { root, env } = repo();
    const before = checkout(root, env);
    writeFileSync(join(root, "scratch.txt"), "notes\n");
    expect(boundaryViolation("tester", before, root, env)).toBeUndefined();
  });

  it("reports a changed branch or HEAD", () => {
    const { root, git, env } = repo();
    const before = checkout(root, env);
    git("switch", "-q", "-c", "other");
    expect(boundaryViolation("reviewer", before, root, env)).toBe(`reviewer switched branch from ${before.branch} to other`);
    git("switch", "-q", before.branch);
    git("commit", "-q", "--allow-empty", "-m", "sneaky");
    expect(boundaryViolation("tester", before, root, env)).toMatch(new RegExp(`^tester moved HEAD from ${before.head} to [0-9a-f]{40}$`));
  });

  it("blocks the workflow when a tester turn changes a tracked file", { timeout: 30_000 }, async () => {
    const w = world({
      developer: "gh fake-record 40 handoff\nexit 0\n",
      tester: 'echo changed >> src/a.ts\nexit 0\n',
      pr: true,
      extraFiles: { "src/a.ts": "export {};\n" },
    });
    expect(gdt(w, "start", "12").code).toBe(0);
    await waitFor("blocked", () => stateOf(w).status === "blocked");
    expect(stateOf(w)).toMatchObject({ reason: "tester changed tracked files: src/a.ts", role: "tester" });
    expect(gdt(w, "status", "12").stdout).toBe("blocked: tester changed tracked files: src/a.ts. Next: resolve the cause; the supervisor checks again on every poll\n");
  });
});

describe("AC-6: role files agree with the protocol", () => {
  const all = [...new Set([...DEVELOPER_STATUSES, ...VERIFIER_STATUSES])];
  it.each([
    ["developer", "[gdt-handoff:v1]", DEVELOPER_STATUSES],
    ["tester", "[gdt-test:v1]", VERIFIER_STATUSES],
    ["reviewer", "[gdt-review:v1]", VERIFIER_STATUSES],
  ] as const)("roles/%s.md names %s and exactly its statuses", (role, marker, statuses) => {
    const text = roleFile(role);
    expect(text).toContain(marker);
    for (const status of all) expect(text.includes(`\`${status}\``), status).toBe((statuses as readonly string[]).includes(status));
  });

  it("roles/issue-writer.md writes no record", () => {
    const text = roleFile("issue-writer");
    expect(text).not.toMatch(/\[gdt-[a-z]+:v1\]/);
    for (const status of all) expect(text).not.toContain(`\`${status}\``);
  });

  it.each(ROLE_FILES)("roles/%s.md is at most 8 KB and in plain English text", (name) => {
    const text = roleFile(name);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8 * 1024);
    expect(text).toMatch(/^[\x20-\x7E\n]*$/);
  });
});

describe("AC-7: issue-writer role produces a checkable contract", () => {
  it("checks the body file before creating, and creates only on request", () => {
    const text = roleFile("issue-writer");
    expect(text).toContain("gdt check-issue --body-file");
    expect(text).toContain("Create the issue only when the user asked you to create it");
    expect(text.indexOf("gdt check-issue --body-file")).toBeLessThan(text.indexOf("gh issue create"));
  });
});

describe("AC-8: check-issue accepts a local body file", () => {
  const threeAcs = BODY.replace("## Non-functional", "**AC-3: Three**\n\n- Given: a\n- When: b\n- Then: c\n- Example: d\n\n## Non-functional");

  it("validates the file without calling GitHub", () => {
    const root = tempRepo({ "body.md": threeAcs });
    const bin = fakePath();
    const result = gdtInProcess(["check-issue", "--body-file", "body.md"], root, bin);
    expect(result.stdout).toBe("body.md: contract valid (3 acceptance criteria)\n");
    expect(result.code).toBe(0);
    expect(existsSync(join(bin, "gh-args"))).toBe(false);
  });

  it("reports an invalid file with exit 1, and supports --json", () => {
    const root = tempRepo({ "body.md": threeAcs.replace("## Goal", "## Doel") });
    const result = gdtInProcess(["check-issue", "--body-file", "body.md"], root, fakePath());
    expect(result.stdout).toContain("body.md: contract invalid (1 error(s))\n  - Missing section: Goal");
    expect(result.code).toBe(1);
    const json = gdtInProcess(["check-issue", "--body-file", "body.md", "--json"], root, fakePath());
    expect(JSON.parse(json.stdout)).toMatchObject({ valid: false, errors: ["Missing section: Goal"] });
  });

  it.each([
    [["12", "--body-file", "body.md"], 2, "not both"],
    [["--body-file"], 2, 'Missing file for "--body-file"'],
    [["--body-file", "nope.md"], 1, "Cannot read nope.md"],
  ])("rejects %j", (args, code, message) => {
    const result = gdtInProcess(["check-issue", ...args], tempRepo(), fakePath());
    expect(result.stderr).toContain(message);
    expect(result.code).toBe(code);
  });
});
