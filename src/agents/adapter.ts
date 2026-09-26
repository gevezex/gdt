import type { Role } from "../config.js";

/** How to run one unattended turn. The prompt never travels as a single argv element. */
export interface Invocation {
  argv: string[];
  /** Variables added to the worker's environment. */
  env: Record<string, string>;
  /** File fed to the agent's stdin, or null for no stdin. */
  stdin: string | null;
}

export interface Adapter {
  /** The executable looked up on PATH. */
  binary: string;
  /** Human name, used in docs and messages. */
  title: string;
  /** Recovery hint when the binary is missing. */
  install: string;
  buildInvocation(role: Role, model: string, promptFile: string, cwd: string): Invocation;
  /** The model provider, used to warn about correlated developer and tester models. */
  vendorOf(model: string): string;
  /** User-level skill directory for the operator skill; `~` is the user's home. */
  skillDir(): string;
}
