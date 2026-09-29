import type { Adapter } from "./adapter.js";

/** Claude Code; see docs/agents.md. */
export const claude: Adapter = {
  binary: "claude",
  title: "Claude Code",
  install: "Install Claude Code: https://docs.anthropic.com/en/docs/claude-code",
  modelFormat: "<model>",
  modelExample: "claude-sonnet-5",
  buildInvocation: (_role, model, promptFile) => ({
    argv: [
      "claude",
      "-p",
      "--model",
      model,
      "--permission-mode",
      "bypassPermissions",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    env: {},
    stdin: promptFile,
    output: "claude-stream-json",
  }),
  vendorOf: () => "anthropic",
  skillDir: () => "~/.claude/skills/gdt",
};
