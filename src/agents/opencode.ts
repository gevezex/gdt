import type { Adapter } from "./adapter.js";

export const OPENCODE_MESSAGE = "Follow the instructions in the attached file.";

/** OpenCode; see docs/agents.md. `opencode run` documents no stdin input, so the prompt is attached as a file. */
export const opencode: Adapter = {
  binary: "opencode",
  title: "OpenCode",
  install: "Install OpenCode: https://opencode.ai",
  buildInvocation: (_role, model, promptFile) => ({
    argv: ["opencode", "run", "--model", model, "--auto", "--file", promptFile, OPENCODE_MESSAGE],
    env: {},
    stdin: null,
  }),
  // "deepseek/deepseek-v4-flash" -> "deepseek"; a model id without a provider is its own vendor.
  vendorOf: (model) => model.split("/")[0] ?? model,
  skillDir: () => "~/.config/opencode/skills/gdt",
};
