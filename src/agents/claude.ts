import type { Adapter } from "./adapter.js";

/** Claude Code; see docs/agents.md. */
export const claude: Adapter = {
  binary: "claude",
  title: "Claude Code",
  install: "Install Claude Code: https://docs.anthropic.com/en/docs/claude-code",
  buildInvocation: (_role, model, promptFile) => ({
    argv: ["claude", "-p", "--model", model, "--permission-mode", "bypassPermissions", "--no-session-persistence"],
    env: {},
    stdin: promptFile,
  }),
  vendorOf: () => "anthropic",
  skillDir: () => "~/.claude/skills/gdt",
};
