import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTERS, type Adapter, type Invocation } from "../src/agents/index.js";
import type { DoctorReport } from "../src/doctor.js";
import { runInvocation } from "../src/worker.js";
import { EXAMPLE_CONFIG, fakePath, gdt, tempRepo } from "./helpers.js";

const DOCS = readFileSync("docs/agents.md", "utf8");

/** The docs section for an adapter: from its `## <title>` heading to the next one. */
function section(title: string): string {
  const start = DOCS.indexOf(`## ${title}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = DOCS.indexOf("\n## ", start + 1);
  return DOCS.slice(start, end === -1 ? undefined : end);
}

function documented(title: string, values: { model: string; prompt: string; cwd: string }): string {
  const block = /```sh\n(.*)\n```/.exec(section(title))?.[1];
  expect(block).toBeDefined();
  return (block ?? "").replace("<model>", values.model).replace(/<prompt-file>/g, values.prompt).replace("<cwd>", values.cwd);
}

function render(inv: Invocation): string {
  const argv = inv.argv.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
  return inv.stdin === null ? argv : `${argv} < ${inv.stdin}`;
}

function adapter(name: "claude" | "codex" | "opencode"): Adapter {
  const found = ADAPTERS[name];
  if (found === undefined) throw new Error(`no adapter ${name}`);
  return found;
}

describe("AC-1: verified invocations are documented", () => {
  it.each([
    ["Claude Code", "claude"],
    ["Codex", "codex"],
    ["OpenCode", "opencode"],
  ])("documents %s", (title, binary) => {
    const text = section(title);
    expect(text).toMatch(new RegExp(`^Verified against: ${binary}(-cli)? v?\\d+\\.\\d+\\.\\d+$`, "m"));
    expect(text).toMatch(/```sh\n.+\n```/);
    for (const label of ["Model:", "Prompt:", "Permissions:", "Skill directory:"]) expect(text).toContain(label);
  });
});

const cwd = "/work/repo";

describe("AC-2: Claude Code adapter matches its verified invocation", () => {
  it("builds the documented invocation", () => {
    const inv = adapter("claude").buildInvocation("tester", "claude-sonnet-5", "/tmp/p.md", cwd);
    expect(render(inv)).toBe(documented("Claude Code", { model: "claude-sonnet-5", prompt: "/tmp/p.md", cwd }));
    expect(inv).toMatchSnapshot();
  });
});

describe("AC-3: Codex adapter matches its verified invocation", () => {
  it("builds the documented invocation", () => {
    const inv = adapter("codex").buildInvocation("reviewer", "gpt-5.6-luna", "/tmp/p.md", cwd);
    expect(render(inv)).toBe(documented("Codex", { model: "gpt-5.6-luna", prompt: "/tmp/p.md", cwd }));
    expect(inv).toMatchSnapshot();
  });
});

describe("AC-4: OpenCode adapter matches its verified invocation", () => {
  it("builds the documented invocation", () => {
    const inv = adapter("opencode").buildInvocation("developer", "deepseek/deepseek-v4-flash", "/tmp/p.md", cwd);
    expect(render(inv)).toBe(documented("OpenCode", { model: "deepseek/deepseek-v4-flash", prompt: "/tmp/p.md", cwd }));
    expect(inv).toMatchSnapshot();
  });

  it("never passes the prompt text as an argument", () => {
    for (const name of ["claude", "codex", "opencode"] as const) {
      const inv = adapter(name).buildInvocation("developer", "m/x", "/tmp/p.md", cwd);
      expect(inv.stdin === "/tmp/p.md" || inv.argv.includes("/tmp/p.md")).toBe(true);
    }
  });
});

describe("AC-5: exit codes pass through unchanged", () => {
  it.each([7, 0, 3])("reports exit code %i", async (code) => {
    expect(await runInvocation({ argv: ["/bin/sh", "-c", `exit ${code}`], env: {}, stdin: null }, tmpdir(), {})).toBe(code);
  });

  it("feeds the prompt file on stdin", async () => {
    const prompt = join(mkdtempSync(join(tmpdir(), "gdt-prompt-")), "p.md");
    writeFileSync(prompt, "hello\n");
    const inv: Invocation = { argv: ["/bin/sh", "-c", 'read line; [ "$line" = hello ] || exit 9'], env: {}, stdin: prompt };
    expect(await runInvocation(inv, tmpdir(), {})).toBe(0);
  });
});

function doctor(config: string, agents: string[]) {
  const result = gdt(["doctor", "--json"], tempRepo({ ".gdt/config.toml": config }), fakePath({ agents }));
  return { code: result.code, report: JSON.parse(result.stdout) as DoctorReport };
}

describe("AC-6: doctor reports missing agent CLIs", () => {
  it("names the role and the missing binary", () => {
    const { code, report } = doctor(EXAMPLE_CONFIG, ["claude", "opencode"]);
    expect(report.findings.filter((f) => f.level === "error")).toEqual([
      { check: "roles.reviewer", level: "error", message: "roles.reviewer: codex not found on PATH", fix: "Install Codex: npm i -g @openai/codex" },
    ]);
    expect(code).toBe(1);
  });

  it("does not check agents used by no role", () => {
    const config = EXAMPLE_CONFIG.replace('agent = "codex"', 'agent = "claude"').replace('model = "gpt-5.6-luna"', 'model = "claude-opus-5-5"');
    const { code, report } = doctor(config, ["claude", "opencode"]);
    expect(report.findings.map((f) => f.message).join("\n")).not.toContain("codex");
    expect(report.findings).toContainEqual(expect.objectContaining({ level: "ok", message: expect.stringMatching(/^roles\.reviewer: claude found at /) }));
    expect(code).toBe(0);
  });
});

describe("AC-7: doctor warns on same-vendor developer and tester", () => {
  it("warns when both use deepseek", () => {
    const config = EXAMPLE_CONFIG.replace('agent = "claude"', 'agent = "opencode"').replace('model = "claude-sonnet-5"', 'model = "deepseek/deepseek-v4-flash"');
    const { code, report } = doctor(config, ["opencode", "codex"]);
    expect(report.findings).toContainEqual({
      check: "roles.tester",
      level: "warning",
      message: "developer and tester both use deepseek; use a different vendor for the tester for independent verification",
      fix: "Set roles.tester to an agent and model from another vendor",
    });
    expect(code).toBe(0);
  });

  it("does not warn for different vendors", () => {
    const { report } = doctor(EXAMPLE_CONFIG, ["claude", "codex", "opencode"]);
    expect(report.findings.filter((f) => f.level === "warning")).toEqual([]);
  });

  it.each([
    ["claude", "claude-sonnet-5", "anthropic"],
    ["codex", "gpt-5.6-luna", "openai"],
    ["opencode", "deepseek/deepseek-v4-flash", "deepseek"],
    ["opencode", "anthropic/claude-sonnet-5", "anthropic"],
  ] as const)("%s model %s has vendor %s", (name, model, vendor) => {
    expect(adapter(name).vendorOf(model)).toBe(vendor);
  });
});

describe("AC-8: skill directories are known per adapter", () => {
  it.each([
    ["claude", "Claude Code", "~/.claude/skills/gdt"],
    ["codex", "Codex", "~/.codex/skills/gdt"],
    ["opencode", "OpenCode", "~/.config/opencode/skills/gdt"],
  ] as const)("%s returns its documented directory", (name, title, dir) => {
    expect(adapter(name).skillDir()).toBe(dir);
    expect(section(title)).toContain(`Skill directory: \`${dir}\``);
  });
});
