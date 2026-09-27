import type { Adapter } from "./adapter.js";

/** Codex CLI; see docs/agents.md. */
export const codex: Adapter = {
  binary: "codex",
  title: "Codex",
  install: "Install Codex: npm i -g @openai/codex",
  modelFormat: "<model>",
  modelExample: "gpt-5.6-luna",
  buildInvocation: (_role, model, promptFile, cwd) => ({
    argv: ["codex", "exec", "--model", model, "--cd", cwd, "--dangerously-bypass-approvals-and-sandbox", "--ephemeral", "-"],
    env: {},
    stdin: promptFile,
  }),
  vendorOf: () => "openai",
  skillDir: () => "~/.codex/skills/gdt",
};
