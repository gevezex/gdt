import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/agents/index.js";
import { renderClaudeLine } from "../src/agents/claude-stream.js";
import { paths } from "../src/state.js";
import type { Dispatch, TurnResult } from "../src/supervisor.js";
import { gdt, stateOf, stopWorlds, waitFor, world, type World } from "./world.js";

afterEach(stopWorlds);

/** A recorded stream: `system`, `assistant` (text + Bash tool_use), `user` (tool_result), `result`. */
const SAMPLE = resolve("test/fixtures/claude-stream.jsonl");
const SAMPLE_LINES = readFileSync(SAMPLE, "utf8").split("\n").filter((line) => line !== "");

const RENDERED = ["I will run the tests.", "→ Bash npm test", "  ✓ ok", "result: success", "All tests pass."];

const TOOL_USE = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}';
const RESULT = '{"type":"result","subtype":"success","result":"done","is_error":false}';

/** Shell-quotes one line for the fake `claude` script. */
const quote = (line: string) => `'${line.replace(/'/g, "'\\''")}'`;

/** Replaces `claude` on the world's PATH with a script. */
function fakeClaude(w: World, script: string): void {
  writeFileSync(join(w.bin, "claude"), `#!/bin/sh\n${script}`);
  chmodSync(join(w.bin, "claude"), 0o755);
}

/** A workflow whose developer runs the fake `claude` agent. */
function claudeDeveloper(script: string): World {
  const w = world({ roleAgents: { developer: "claude" } });
  fakeClaude(w, script);
  return w;
}

function roleLog(w: World, role: string): string {
  const file = join(w.root, `.git/gdt/issue-12/logs/${role}.log`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** The result of the role's current dispatch, or null before the turn has finished. */
function turnResult(w: World, role: "developer" | "tester"): TurnResult | null {
  const p = paths(w.root, 12, w.env);
  if (!existsSync(p.dispatch(role))) return null;
  const { key } = JSON.parse(readFileSync(p.dispatch(role), "utf8")) as Dispatch;
  return existsSync(p.result(key)) ? (JSON.parse(readFileSync(p.result(key), "utf8")) as TurnResult) : null;
}

/** Runs the developer turn with the fake `claude` and returns its log and result. */
async function runDeveloper(script: string): Promise<{ log: string; result: TurnResult }> {
  const w = claudeDeveloper(script);
  expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
  await waitFor("the developer result", () => turnResult(w, "developer") !== null);
  await waitFor("the finished line", () => roleLog(w, "developer").includes("finished with exit code"));
  return { log: roleLog(w, "developer"), result: turnResult(w, "developer") as TurnResult };
}

/** Asserts that `expected` appear as whole lines of `log`, in this order. */
function expectLinesInOrder(log: string, expected: string[]): void {
  const lines = log.split("\n");
  let from = 0;
  for (const line of expected) {
    const at = lines.indexOf(line, from);
    expect(at, `line ${JSON.stringify(line)} after line ${from}`).toBeGreaterThanOrEqual(0);
    from = at + 1;
  }
}

describe("AC-1: the claude adapter runs with the event stream on", () => {
  it("adds --output-format stream-json --verbose and keeps the prompt on stdin", () => {
    const inv = ADAPTERS.claude?.buildInvocation("tester", "claude-sonnet-5", "/tmp/p.md", "/work/repo");
    expect(inv?.argv).toEqual([
      "claude",
      "-p",
      "--model",
      "claude-sonnet-5",
      "--permission-mode",
      "bypassPermissions",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    expect(inv?.stdin).toBe("/tmp/p.md");
    expect(readFileSync("docs/agents.md", "utf8")).toContain("--output-format stream-json --verbose");
  });
});

describe("AC-2: the worker renders the claude stream while the turn runs", { timeout: 30_000 }, () => {
  it("renders every event of a recorded sample", () => {
    expect(SAMPLE_LINES.flatMap((line) => renderClaudeLine(line, false))).toEqual(["[system]", ...RENDERED]);
  });

  it("summarises a tool call by command, file, pattern or input, on one line of at most 120 characters", () => {
    const call = (input: unknown) =>
      renderClaudeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "T", input }] } }), false);
    expect(call({ command: "npm test\nnpm run lint", file_path: "a.ts" })).toEqual(["→ T npm test"]);
    expect(call({ file_path: "src/a.ts", pattern: "x" })).toEqual(["→ T src/a.ts"]);
    expect(call({ pattern: "TODO" })).toEqual(["→ T TODO"]);
    expect(call({ url: "https://example.com" })).toEqual(['→ T {"url":"https://example.com"}']);
    expect(call({ command: "x".repeat(200) })).toEqual([`→ T ${"x".repeat(120)}`]);
  });

  it("renders a multi-line text as several lines and a failed tool result as an error", () => {
    const text = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "one\ntwo" }] } });
    expect(renderClaudeLine(text, false)).toEqual(["one", "two"]);
    const failed = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: true }] } });
    expect(renderClaudeLine(failed, false)).toEqual(["  ✗ error"]);
  });

  it("writes the rendered lines, not the raw JSON, to the worker's stdout", async () => {
    const { log } = await runDeveloper(`exec /bin/cat "${SAMPLE}"\n`);
    expectLinesInOrder(log, RENDERED);
    expect(log).not.toContain('{"type":');
  });

  it("writes a line before the agent writes its next event", async () => {
    const w = claudeDeveloper(
      [`printf '%s\\n' ${quote(TOOL_USE)}`, 'echo > "$0.wrote"', "/bin/sleep 2", `printf '%s\\n' ${quote(RESULT)}`, ""].join("\n"),
    );
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the tool_use event", () => existsSync(join(w.bin, "claude.wrote")));
    await waitFor("the rendered tool call", () => roleLog(w, "developer").includes("→ Bash npm test\n"), 1000);
    expect(roleLog(w, "developer")).not.toContain("result: success");
    await waitFor("the result line", () => roleLog(w, "developer").includes("result: success\ndone\n"));
  });
});

describe("AC-3: malformed and unknown stream items never fail the turn", { timeout: 30_000 }, () => {
  it("passes through non-JSON lines, names unknown events and items, and skips empty lines", () => {
    const thinking = JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } });
    expect(renderClaudeLine("not json", false)).toEqual(["not json"]);
    expect(renderClaudeLine('{"type":"rate_limit_event"}', false)).toEqual(["[rate_limit_event]"]);
    expect(renderClaudeLine(thinking, false)).toEqual(["[thinking]"]);
    expect(renderClaudeLine("", false)).toEqual([]);
    expect(renderClaudeLine("[1,2]", false)).toEqual(["[1,2]"]);
  });

  it("dims a passthrough line for a valid object only on a TTY", () => {
    expect(renderClaudeLine('{"type":"system"}', true)).toEqual(["\x1b[2m[system]\x1b[0m"]);
    expect(renderClaudeLine("not json", true)).toEqual(["not json"]);
  });

  it("finishes the turn with exit code 0", async () => {
    const thinking = '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"}]}}';
    const stream = ["not json", '{"type":"rate_limit_event"}', thinking, "", RESULT];
    const { log, result } = await runDeveloper(`printf '%s\\n' ${stream.map(quote).join(" ")}\n`);
    expectLinesInOrder(log, ["not json", "[rate_limit_event]", "[thinking]", "result: success", "done"]);
    expect(result.exit_code).toBe(0);
  });
});

describe("AC-4: exit code and result handling are unchanged", { timeout: 30_000 }, () => {
  it("keeps exit code 0 when the result event is an error", async () => {
    const error = '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"x"}';
    const { log, result } = await runDeveloper(`printf '%s\\n' ${quote(error)}\nexit 0\n`);
    expectLinesInOrder(log, ["result: error_max_turns", "x"]);
    expect(result.exit_code).toBe(0);
    expect(log).toContain("finished with exit code 0");
  });

  it("passes a non-zero exit code through after a successful result event", async () => {
    const { result, log } = await runDeveloper(`printf '%s\\n' ${quote(RESULT)}\nexit 3\n`);
    expect(result.exit_code).toBe(3);
    expect(log).toContain("finished with exit code 3");
  });
});

describe("AC-5: headless role logs contain the rendered progress", { timeout: 30_000 }, () => {
  it("writes the rendered tester progress to tester.log without ANSI codes or raw JSON", async () => {
    const w = world({ pr: true, developer: "gh fake-record 40 handoff\nexit 0\n", roleAgents: { tester: "claude" } });
    fakeClaude(w, `exec /bin/cat "${SAMPLE}"\n`);
    expect(gdt(w, "start", "12")).toMatchObject({ code: 0, stderr: "" });
    await waitFor("the tester turn", () => stateOf(w).role === "tester" || turnResult(w, "tester") !== null);
    await waitFor("the tester result", () => turnResult(w, "tester") !== null);
    await waitFor("the finished line", () => roleLog(w, "tester").includes("finished with exit code"));
    const log = roleLog(w, "tester");
    expectLinesInOrder(log, RENDERED);
    expect(log).toContain("→ Bash npm test\n");
    expect(log).toContain("  ✓ ok\n");
    expect(log).not.toContain('{"type":"assistant"');
    expect(log).not.toContain("\x1b");
  });
});

describe("AC-6: the README states per agent what the pane shows", () => {
  it("has one table row per supported agent, and the claude row names the rendered progress", () => {
    const readme = readFileSync("README.md", "utf8");
    const rows = Object.keys(ADAPTERS).map((agent) => readme.split("\n").find((line) => line.startsWith(`| \`${agent}\` |`)));
    expect(Object.keys(ADAPTERS).sort()).toEqual(["claude", "codex", "mcode", "omp", "opencode", "pi"]);
    for (const row of rows) expect(row).toBeDefined();
    const claude = rows[0] ?? "";
    for (const part of ["assistant text", "tool calls", "tool results", "final result", "while the turn runs"]) expect(claude).toContain(part);
  });
});
