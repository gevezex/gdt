import type { Agent } from "../config.js";
import type { Adapter } from "./adapter.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { mcode } from "./mcode.js";
import { omp } from "./omp.js";
import { opencode } from "./opencode.js";
import { pi } from "./pi.js";

export type { Adapter, Invocation } from "./adapter.js";

/** One adapter per agent; an agent with no entry has no unattended invocation (docs/agents.md). */
export const ADAPTERS: Partial<Record<Agent, Adapter>> = { claude, codex, opencode, mcode, pi, omp };

export function adapterFor(agent: string): Adapter | undefined {
  return ADAPTERS[agent as Agent];
}

/** The agents gdt can actually run right now, in a stable order. */
export function supportedAgents(): Agent[] {
  return Object.keys(ADAPTERS) as Agent[];
}
