import { type Adapter, vendorFromModel } from "./adapter.js";

/** MiniMax Code; see docs/agents.md. `mcode exec --input -` reads the prompt from stdin. */
export const mcode: Adapter = {
  binary: "mcode",
  title: "MCode",
  install: "Install MiniMax Code: npm i -g @minimax-ai/code",
  modelFormat: "provider/model",
  modelExample: "minimax/MiniMax-M3",
  buildInvocation: (_role, model, promptFile, cwd) => ({
    argv: ["mcode", "exec", "--model", model, "--cwd", cwd, "--permission", "full", "--input", "-"],
    env: {},
    stdin: promptFile,
  }),
  vendorOf: vendorFromModel,
  skillDir: () => "~/.minimax/skills/gdt",
};
