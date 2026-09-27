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

/** Strips the surrounding quotes of one TOML key segment. */
function unquoteKey(segment: string): string {
  if (segment.length >= 2 && segment.startsWith('"') && segment.endsWith('"')) {
    try {
      const value: unknown = JSON.parse(segment);
      if (typeof value === "string") return value;
    } catch {
      // Not JSON-compatible; fall back to a plain strip.
    }
    return segment.slice(1, -1);
  }
  if (segment.length >= 2 && segment.startsWith("'") && segment.endsWith("'")) return segment.slice(1, -1);
  return segment;
}

/** Splits a TOML dotted key into its segments, honoring quoted segments (e.g. `roles."a.b"`). */
function keySegments(key: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < key.length; i += 1) {
    const ch = key[i] ?? "";
    if (quote === '"') {
      current += ch;
      if (ch === "\\") {
        current += key[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ".") {
      segments.push(unquoteKey(current.trim()));
      current = "";
    } else {
      current += ch;
    }
  }
  segments.push(unquoteKey(current.trim()));
  return segments;
}

const HEADER_RE = /^\s*\[\[?\s*(.*?)\s*\]\]?\s*(?:#.*)?$/;

/** The dotted path of a `[table]` / `[[array]]` header, or null when the line is not a header. */
function headerSegments(line: string): string[] | null {
  const match = HEADER_RE.exec(line);
  return match === null ? null : keySegments(match[1] ?? "");
}

/** Splits `key = value` at the first `=` outside quoted key segments. */
function splitAssignment(line: string): { key: string; value: string } | null {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? "";
    if (quote === '"') {
      if (ch === "\\") i += 1;
      else if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "=") return { key: line.slice(0, i), value: line.slice(i + 1) };
  }
  return null;
}

type ScanMode = "normal" | "basic" | "literal" | "basic-multi" | "literal-multi";

/** Tracks one TOML value across lines so multi-line values stay attached to their assignment. */
class ValueScan {
  private depth = 0;
  private mode: ScanMode = "normal";

  /** Feeds one line; returns true once the value is complete at the end of that line. */
  feed(line: string): boolean {
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i] ?? "";
      switch (this.mode) {
        case "normal":
          if (ch === "#") i = line.length;
          else if (ch === '"') {
            if (line.startsWith('"""', i)) {
              this.mode = "basic-multi";
              i += 2;
            } else this.mode = "basic";
          } else if (ch === "'") {
            if (line.startsWith("'''", i)) {
              this.mode = "literal-multi";
              i += 2;
            } else this.mode = "literal";
          } else if (ch === "[" || ch === "{") this.depth += 1;
          else if (ch === "]" || ch === "}") this.depth -= 1;
          break;
        case "basic":
          if (ch === "\\") i += 1;
          else if (ch === '"') this.mode = "normal";
          break;
        case "literal":
          if (ch === "'") this.mode = "normal";
          break;
        case "basic-multi":
          if (line.startsWith('"""', i)) {
            this.mode = "normal";
            i += 2;
          } else if (ch === "\\") i += 1;
          break;
        case "literal-multi":
          if (line.startsWith("'''", i)) {
            this.mode = "normal";
            i += 2;
          }
          break;
      }
    }
    return this.mode === "normal" && this.depth === 0;
  }
}

/**
 * AC-5: replaces the `roles` key of `existing`, keeping every other line (comments, other keys and
 * tables) byte-for-byte. Roles are removed whatever valid TOML form they were written in — role
 * tables, a `[roles]` table with inline entries, a top-level inline `roles = { ... }`, or dotted
 * keys — so a rewrite never leaves a duplicate definition behind. The new tables are appended.
 */
export function upsertRoles(existing: string, roles: Record<Role, RoleSpec>): string {
  const kept: string[] = [];
  let table: string[] | null = null;
  let pending: { scan: ValueScan; drop: boolean } | null = null;

  for (const line of existing.split("\n")) {
    if (pending !== null) {
      const complete = pending.scan.feed(line);
      if (!pending.drop) kept.push(line);
      if (complete) pending = null;
      continue;
    }

    const trimmed = line.trim();
    const inRoleRegion = table !== null && table[0] === "roles";

    if (trimmed === "" || trimmed.startsWith("#")) {
      if (!inRoleRegion) kept.push(line);
      continue;
    }

    const header = headerSegments(line);
    if (header !== null) {
      table = header;
      if (header[0] !== "roles") kept.push(line);
      continue;
    }

    const assignment = splitAssignment(line);
    if (assignment === null) {
      if (!inRoleRegion) kept.push(line);
      continue;
    }

    const drop = inRoleRegion || (table === null && keySegments(assignment.key)[0] === "roles");
    if (!drop) kept.push(line);
    const scan = new ValueScan();
    if (!scan.feed(assignment.value)) pending = { scan, drop };
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
