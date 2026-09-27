import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { adapterFor, supportedAgents } from "./agents/index.js";
import { type Agent, CONFIG_PATH, DEFAULT_LANGUAGE, type Role, ROLES, userConfigPath } from "./config.js";
import { herdrPreflight, which } from "./doctor.js";
import { detectedChecks } from "./github.js";
import { ROLE_RULES_DIR, roleRulesPath } from "./prompts.js";

type Env = Record<string, string | undefined>;

export type Terminal = "herdr" | "headless";

/** One supported agent in the AC-1 proposal. */
export interface AgentChoice {
  agent: Agent;
  /** The agent's binary is on PATH. */
  found: boolean;
  /** The model id shape for this agent, from its adapter (docs/agents.md). */
  model_format: string;
  /** One example model id; gdt ships no default model. */
  example: string;
}

/** The facts `gdt init` reports without role options (AC-1); it writes nothing. */
export interface Proposal {
  agents: AgentChoice[];
  terminal: Terminal;
  required_checks: string[];
  language: string;
}

/** The proposal: one entry per supported agent, the usable terminal, detected checks and language. */
export function proposal(root: string, env: Env): Proposal {
  const agents = supportedAgents().flatMap((agent): AgentChoice[] => {
    const adapter = adapterFor(agent);
    if (adapter === undefined) return [];
    return [
      {
        agent,
        found: which(adapter.binary, env) !== null,
        model_format: adapter.modelFormat,
        example: adapter.modelExample,
      },
    ];
  });
  return {
    agents,
    terminal: herdrPreflight(env) === null ? "herdr" : "headless",
    required_checks: detectedChecks(root, env),
    language: DEFAULT_LANGUAGE,
  };
}

export interface RoleSpec {
  agent: Agent;
  model: string;
}

/** Parses `<agent>/<model>` at the first `/`, the same way `gdt set-agent` does. */
export function parseRoleSpec(spec: string): RoleSpec | { error: string } {
  const slash = spec.indexOf("/");
  const agent = slash === -1 ? spec : spec.slice(0, slash);
  const model = slash === -1 ? "" : spec.slice(slash + 1);
  const supported = supportedAgents();
  if (!supported.includes(agent as Agent)) {
    return { error: `Unsupported agent "${agent}"; supported agents: ${supported.join(", ")}` };
  }
  if (model.trim() === "") return { error: `Missing model in "${spec}"; use <agent>/<model>` };
  return { agent: agent as Agent, model };
}

/** The project settings `gdt init` writes; roles live in the user config (AC-5). */
export interface RepoConfig {
  language: string;
  terminal: Terminal;
  requiredChecks: string[];
  allowNoRequiredChecks: boolean;
}

/** The `.gdt/config.toml` text without roles; a key that keeps its schema default is not written. */
export function serializeConfig(config: RepoConfig): string {
  const lines: string[] = [];
  if (config.language !== DEFAULT_LANGUAGE) lines.push(`language = ${JSON.stringify(config.language)}`, "");
  lines.push("[workflow]", `required_checks = [${config.requiredChecks.map((name) => JSON.stringify(name)).join(", ")}]`);
  if (config.allowNoRequiredChecks) lines.push("allow_no_required_checks = true");
  if (config.terminal !== "herdr") lines.push(`terminal = ${JSON.stringify(config.terminal)}`);
  lines.push("");
  return lines.join("\n");
}

function roleTable(role: Role, spec: RoleSpec): string {
  return `[roles.${role}]\nagent = ${JSON.stringify(spec.agent)}\nmodel = ${JSON.stringify(spec.model)}\n`;
}

/** The user config text for `roles`, used when the file does not exist yet. */
export function serializeUserConfig(roles: Record<Role, RoleSpec>): string {
  return ROLES.map((role) => roleTable(role, roles[role])).join("\n");
}

const ROLE_HEADER = /^\[roles\.(developer|tester|reviewer)\]$/;

/**
 * AC-5: replaces only the `[roles.<role>]` tables of `existing`, keeping every other line
 * (comments and other tables) byte-for-byte. The new tables are appended at the end.
 */
export function upsertRoles(existing: string, roles: Record<Role, RoleSpec>): string {
  const kept: string[] = [];
  let inRoleTable = false;
  for (const line of existing.split("\n")) {
    const header = /^\[[^\]]+\]/.exec(line.trim())?.[0];
    if (header !== undefined) inRoleTable = ROLE_HEADER.test(header);
    if (!inRoleTable) kept.push(line);
  }
  while (kept.length > 0 && (kept[kept.length - 1] ?? "").trim() === "") kept.pop();
  const prefix = kept.length > 0 ? `${kept.join("\n")}\n\n` : "";
  const blocks = ROLES.map((role) => roleTable(role, roles[role]).trimEnd()).join("\n\n");
  return `${prefix}${blocks}\n`;
}

/** Writes the roles to the user config, creating its directory; returns an error message or null. */
export function writeUserConfig(env: Env, roles: Record<Role, RoleSpec>): string | null {
  const path = userConfigPath(env);
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, existing === null ? serializeUserConfig(roles) : upsertRoles(existing, roles));
    return null;
  } catch (err) {
    return `Cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Writes the config, creating `.gdt/` when needed; returns an error message, or null on success. */
export function writeConfig(root: string, text: string): string | null {
  try {
    const path = join(root, CONFIG_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return null;
  } catch (err) {
    return `Cannot write ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * AC-4: creates each missing `.gdt/roles/<role>.md` as an empty file and returns its
 * repository-relative path. An existing file is never touched, not even with `--force`.
 */
export function createRoleRulesFiles(root: string): string[] {
  const created: string[] = [];
  for (const role of ROLES) {
    const path = roleRulesPath(root, role);
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, "", { flag: "wx" });
      created.push(`${ROLE_RULES_DIR}/${role}.md`);
    } catch (err) {
      // Exists already: leave it byte-for-byte unchanged.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  return created;
}
