import type { Agent } from "../config.js";
import type { Adapter } from "./adapter.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { opencode } from "./opencode.js";

export type { Adapter, Invocation } from "./adapter.js";

/** Adapters implemented so far; MCode, pi and omp follow in #9. */
export const ADAPTERS: Partial<Record<Agent, Adapter>> = { claude, codex, opencode };

export function adapterFor(agent: string): Adapter | undefined {
  return ADAPTERS[agent as Agent];
}
