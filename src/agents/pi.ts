import { type Adapter, vendorFromModel } from "./adapter.js";

/** pi; see docs/agents.md. `--print` reads the prompt from stdin and exits after one turn. */
export const pi: Adapter = {
  binary: "pi",
  title: "pi",
  install: "Install pi: npm i -g --ignore-scripts @earendil-works/pi-coding-agent",
  buildInvocation: (_role, model, promptFile) => ({
    argv: ["pi", "--print", "--model", model, "--no-session", "--no-approve"],
    env: {},
    stdin: promptFile,
  }),
  vendorOf: vendorFromModel,
  skillDir: () => "~/.pi/agent/skills/gdt",
};
