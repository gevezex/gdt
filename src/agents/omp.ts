import { type Adapter, vendorFromModel } from "./adapter.js";

/** omp; see docs/agents.md. `--print` reads the prompt from stdin; `--auto-approve` skips approvals. */
export const omp: Adapter = {
  binary: "omp",
  title: "omp",
  install: "Install omp: https://omp.sh",
  modelFormat: "provider/id",
  modelExample: "openai/gpt-5.2",
  buildInvocation: (_role, model, promptFile) => ({
    argv: ["omp", "--print", "--model", model, "--no-session", "--auto-approve"],
    env: {},
    stdin: promptFile,
  }),
  vendorOf: vendorFromModel,
  skillDir: () => "~/.omp/agent/skills/gdt",
};
