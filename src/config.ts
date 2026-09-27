import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse as parseToml, TomlError } from "smol-toml";
import { z } from "zod";
import { type Finding, hasErrors } from "./finding.js";

export const AGENTS = ["claude", "codex", "opencode", "mcode", "pi", "omp"] as const;
export const ROLES = ["developer", "tester", "reviewer"] as const;
export const TERMINALS = ["herdr", "headless"] as const;
/** AC-2: how the herdr backend places the managed panes. */
export const HERDR_LAYOUTS = ["split", "tabs"] as const;

export const CONFIG_PATH = ".gdt/config.toml";
export const LOCAL_CONFIG_PATH = ".gdt/config.local.toml";
/** The `gdt` directory under the XDG config home that holds the per-user config. */
export const USER_CONFIG_DIR = "gdt";

export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_MAX_ACCEPTANCE_CRITERIA = 8;

export type Agent = (typeof AGENTS)[number];
export type Role = (typeof ROLES)[number];
export type HerdrLayout = (typeof HERDR_LAYOUTS)[number];

/** The test agent: runs `script` instead of a coding agent. Only accepted when GDT_TEST_AGENTS=1. */
export const TEST_AGENT = "fake";

type Env = Record<string, string | undefined>;

/** The OS home directory, or `env.HOME` when it names one (AC-1 of issue #51). */
function homeDir(env: Env): string {
  const home = env.HOME;
  return home === undefined || home === "" ? homedir() : home;
}

/**
 * The per-user config path. `$XDG_CONFIG_HOME/gdt/config.toml` when `XDG_CONFIG_HOME` is an
 * absolute path, otherwise `$HOME/.config/gdt/config.toml`. A relative `XDG_CONFIG_HOME` is
 * ignored, as the XDG base directory specification requires.
 */
export function userConfigPath(env: Env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homeDir(env), ".config");
  return join(base, USER_CONFIG_DIR, "config.toml");
}

const roleSchema = z.strictObject({
  agent: z.enum(AGENTS),
  model: z.string().min(1),
});

const testRoleSchema = z
  .strictObject({
    agent: z.enum([...AGENTS, TEST_AGENT]),
    model: z.string().min(1),
    script: z.string().min(1).optional(),
  })
  .superRefine((role, ctx) => {
    if (role.agent === TEST_AGENT && role.script === undefined) {
      ctx.addIssue({ code: "custom", path: ["script"], message: `required for agent "${TEST_AGENT}"` });
    }
    if (role.agent !== TEST_AGENT && role.script !== undefined) {
      ctx.addIssue({ code: "custom", path: ["script"], message: `only allowed for agent "${TEST_AGENT}"` });
    }
  });

function configSchemaFor(testAgents: boolean) {
  const role = testAgents ? testRoleSchema : roleSchema;
  return z.strictObject({
    language: z.string().min(1).default(DEFAULT_LANGUAGE),
    // Roles live in the user config now; a role that is absent is reported separately (AC-4).
    roles: z
      .strictObject({ developer: role.optional(), tester: role.optional(), reviewer: role.optional() })
      .optional(),
    workflow: z.strictObject({
      max_correction_rounds: z.int().min(0).default(2),
      // Deliberately without a default: an empty gate must be an explicit choice.
      required_checks: z.array(z.string().min(1)),
      allow_no_required_checks: z.boolean().default(false),
      terminal: z.enum(TERMINALS).default("herdr"),
      supervisor_pane: z.boolean().default(false),
      // Default `tabs`: one tab per managed pane. `split` keeps the panes in one tab.
      herdr_layout: z.enum(HERDR_LAYOUTS).default("tabs"),
      poll_seconds: z.number().positive().default(30),
      handoff_checks: z.int().min(1).default(5),
    }),
    contract: z
      .strictObject({
        max_acceptance_criteria: z.int().min(1).default(DEFAULT_MAX_ACCEPTANCE_CRITERIA),
        extra_rules: z.string().min(1).optional(),
      })
      .prefault({}),
  });
}

export const configSchema = configSchemaFor(false);

export function testAgentsEnabled(env: Env): boolean {
  return env.GDT_TEST_AGENTS === "1";
}

export type Config = z.infer<ReturnType<typeof configSchemaFor>>;

export interface ResolvedRole {
  agent: Agent | typeof TEST_AGENT;
  model: string;
  script?: string;
  /** The config file that last set a key of this role. */
  source: string;
}

export interface ResolvedConfig extends Omit<Config, "roles"> {
  roles: Record<Role, ResolvedRole>;
}

/** Serialised as-is under `config` in `gdt doctor --json`; keep these paths stable. */
export type ConfigReport =
  | ({ valid: true; files: string[] } & ResolvedConfig)
  | { valid: false; files: string[] };

/** Which of the three layers a config file belongs to. */
export type LayerKind = "user" | "repo" | "local";

interface Layer {
  path: string;
  kind: LayerKind;
  data: Record<string, unknown>;
}

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge(base: Table, over: Table): Table {
  const out: Table = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] = isTable(current) && isTable(value) ? merge(current, value) : value;
  }
  return out;
}

function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let current = data;
  for (const key of path) {
    if (!isTable(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.map(String).join(".");
}

/** The layer that supplied the value at `path`, preferring the later layer. */
function sourceOf(layers: readonly Layer[], path: readonly PropertyKey[]): string {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer && valueAt(layer.data, path) !== undefined) return layer.path;
  }
  return layers[0]?.path ?? CONFIG_PATH;
}

/** The config file that last set a key of `role`; a role is only layered in the user and local config. */
function roleSource(layers: readonly Layer[], role: Role, fallback: string): string {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer === undefined) continue;
    const table = valueAt(layer.data, ["roles", role]);
    if (isTable(table) && Object.keys(table).length > 0) return layer.path;
  }
  return fallback;
}

function describe(value: unknown): string {
  return value === undefined ? "missing" : JSON.stringify(value);
}

function issueFindings(issue: z.core.$ZodIssue, merged: Table, layers: readonly Layer[]): Finding[] {
  const key = formatPath(issue.path);
  const input = valueAt(merged, issue.path);
  const file = sourceOf(layers, issue.path);
  const error = (message: string, fix: string): Finding => ({ check: "config", level: "error", message, fix });

  switch (issue.code) {
    case "invalid_value": {
      const allowed = issue.values.map(String).join(", ");
      return [error(`${key}: ${describe(input)} is not one of ${allowed}`, `Set ${key} in ${file} to one of ${allowed}`)];
    }
    case "invalid_type":
      if (input === undefined) {
        return [error(`${key}: missing; expected ${issue.expected}`, `Add ${key} to ${file}`)];
      }
      return [error(`${key}: expected ${issue.expected}, got ${describe(input)}`, `Correct ${key} in ${file}`)];
    case "unrecognized_keys":
      return issue.keys.map((unknownKey) => {
        const fullKey = formatPath([...issue.path, unknownKey]);
        return error(`${fullKey}: unknown key`, `Remove or rename ${fullKey} in ${sourceOf(layers, [...issue.path, unknownKey])}`);
      });
    default:
      return [error(`${key}: ${issue.message}`, `Correct ${key} in ${file}`)];
  }
}

/** Reads and parses one TOML file; `display` is the path used in findings. */
function readLayer(fullPath: string, display: string, kind: LayerKind): Layer | Finding {
  const text = readFileSync(fullPath, "utf8");
  try {
    return { path: display, kind, data: parseToml(text) };
  } catch (err) {
    const where = err instanceof TomlError ? ` at line ${err.line}, column ${err.column}` : "";
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return {
      check: "config",
      level: "error",
      message: `${display}: invalid TOML${where}: ${reason}`,
      fix: `Fix the TOML syntax in ${display}`,
    };
  }
}

export interface UserRoleSpec {
  agent: string;
  model: string;
  script?: string;
}

export interface UserConfigRead {
  /** The absolute user config path, whether or not the file exists. */
  path: string;
  exists: boolean;
  /** The roles the user config defines as complete `agent`/`model` pairs. */
  roles: Partial<Record<Role, UserRoleSpec>>;
  /** The role tables the user config contains, complete or not. */
  defined: Role[];
  /** Parse errors, so callers can refuse before writing anything. */
  findings: Finding[];
}

/**
 * Reads the user config for `gdt init`. It parses the file and reports which role tables it
 * contains; it does not validate the repository config, because `gdt init` may run before that
 * file exists (AC-6).
 */
export function readUserConfig(env: Env): UserConfigRead {
  const path = userConfigPath(env);
  if (!existsSync(path)) return { path, exists: false, roles: {}, defined: [], findings: [] };
  const layer = readLayer(path, path, "user");
  if (!("data" in layer)) return { path, exists: true, roles: {}, defined: [], findings: [layer] };

  const roles: Partial<Record<Role, UserRoleSpec>> = {};
  const defined: Role[] = [];
  const raw = layer.data.roles;
  if (isTable(raw)) {
    for (const role of ROLES) {
      const table = raw[role];
      if (!isTable(table)) continue;
      defined.push(role);
      if (typeof table.agent === "string" && typeof table.model === "string") {
        roles[role] = {
          agent: table.agent,
          model: table.model,
          ...(typeof table.script === "string" ? { script: table.script } : {}),
        };
      }
    }
  }
  return { path, exists: true, roles, defined, findings: [] };
}

function roleMissingFinding(role: Role, userPath: string): Finding {
  const init = "gdt init --developer <agent>/<model> --tester <agent>/<model> --reviewer <agent>/<model>";
  return {
    check: "config",
    level: "error",
    message: `roles.${role}: missing`,
    fix: `Add roles.${role} to ${userPath} with "${init}"`,
  };
}

/**
 * Loads the user config, the repository config and the local config, merges them in that order
 * (later layers win per key) and validates the result. Roles are read from the user config unless
 * the local config overrides them; a `[roles.*]` table in the repository config is an error (AC-2).
 */
export function loadConfig(root: string, env: Env = {}): { report: ConfigReport; findings: Finding[] } {
  const userPath = userConfigPath(env);
  const repoPath = join(root, CONFIG_PATH);
  const localPath = join(root, LOCAL_CONFIG_PATH);
  const userExists = existsSync(userPath);
  const repoExists = existsSync(repoPath);
  const localExists = existsSync(localPath);

  const files: string[] = [];
  if (userExists) files.push(userPath);
  if (repoExists) files.push(CONFIG_PATH);
  if (localExists) files.push(LOCAL_CONFIG_PATH);

  if (!repoExists) {
    return {
      report: { valid: false, files },
      findings: [
        {
          check: "config",
          level: "error",
          message: `${CONFIG_PATH}: not found`,
          fix: `Create ${CONFIG_PATH}; example: https://github.com/gevezex/gdt/blob/main/examples/config.toml`,
        },
      ],
    };
  }

  const layers: Layer[] = [];
  const findings: Finding[] = [];
  const inputs: [string, string, LayerKind][] = [[repoPath, CONFIG_PATH, "repo"]];
  if (userExists) inputs.unshift([userPath, userPath, "user"]);
  if (localExists) inputs.push([localPath, LOCAL_CONFIG_PATH, "local"]);

  for (const [full, display, kind] of inputs) {
    const layer = readLayer(full, display, kind);
    if ("data" in layer) layers.push(layer);
    else findings.push(layer);
  }
  if (findings.length > 0) return { report: { valid: false, files }, findings };

  const userLayer = layers.find((layer) => layer.kind === "user");
  const repoLayer = layers.find((layer) => layer.kind === "repo");

  // AC-3: the user config holds only roles.
  if (userLayer !== undefined) {
    for (const key of Object.keys(userLayer.data)) {
      if (key === "roles") continue;
      findings.push({
        check: "config",
        level: "error",
        message: `${key}: not allowed in ${userPath}`,
        fix: `Move ${key} to ${CONFIG_PATH}`,
      });
    }
  }

  // AC-2: the repository config must not commit roles.
  const repoRoles = repoLayer?.data.roles;
  if (isTable(repoRoles)) {
    for (const role of Object.keys(repoRoles)) {
      findings.push({
        check: "config",
        level: "error",
        message: `roles.${role}: not allowed in ${CONFIG_PATH}`,
        fix: `Move roles.${role} to ${userPath} or ${LOCAL_CONFIG_PATH}`,
      });
    }
  } else if (repoRoles !== undefined) {
    findings.push({
      check: "config",
      level: "error",
      message: `roles: not allowed in ${CONFIG_PATH}`,
      fix: `Move roles to ${userPath} or ${LOCAL_CONFIG_PATH}`,
    });
  }

  // Roles come from the user config and the local config only; the repository config is excluded.
  const roleData = layers
    .filter((layer) => layer.kind !== "repo")
    .reduce<Table>((acc, layer) => (isTable(layer.data.roles) ? merge(acc, layer.data.roles) : acc), {});

  const merged = layers.reduce<Table>((acc, layer) => {
    const copy = { ...layer.data };
    delete copy.roles;
    return merge(acc, copy);
  }, {});
  if (Object.keys(roleData).length > 0) merged.roles = roleData;

  const parsed = configSchemaFor(testAgentsEnabled(env)).safeParse(merged);
  if (!parsed.success) {
    findings.push(...parsed.error.issues.flatMap((issue) => issueFindings(issue, merged, layers)));
  }

  // AC-4: every role the user and local configs do not define is an error pointing at the user config.
  for (const role of ROLES) {
    if (!isTable(valueAt(merged, ["roles", role]))) findings.push(roleMissingFinding(role, userPath));
  }

  if (hasErrors(findings) || !parsed.success) return { report: { valid: false, files }, findings };

  const config = parsed.data;
  const resolved = {
    developer: { ...config.roles?.developer, source: roleSource(layers, "developer", userPath) },
    tester: { ...config.roles?.tester, source: roleSource(layers, "tester", userPath) },
    reviewer: { ...config.roles?.reviewer, source: roleSource(layers, "reviewer", userPath) },
  } as Record<Role, ResolvedRole>;

  findings.push({
    check: "config",
    level: "ok",
    message:
      localExists && userExists
        ? `${CONFIG_PATH} is valid, with roles from ${userPath} and overrides from ${LOCAL_CONFIG_PATH}`
        : localExists
          ? `${CONFIG_PATH} is valid, with overrides from ${LOCAL_CONFIG_PATH}`
          : `${CONFIG_PATH} is valid`,
    fix: "",
  });
  findings.push(...semanticFindings(root, config));

  const report: ConfigReport = {
    valid: true,
    files,
    language: config.language,
    workflow: config.workflow,
    contract: config.contract,
    roles: resolved,
  };
  return { report, findings };
}

/** Checks that pass the schema but would make gdt unsafe or surprising. */
function semanticFindings(root: string, config: Config): Finding[] {
  const findings: Finding[] = [];

  if (config.workflow.required_checks.length === 0) {
    findings.push({
      check: "workflow.required_checks",
      level: config.workflow.allow_no_required_checks ? "warning" : "error",
      message: "workflow.required_checks is empty; set workflow.allow_no_required_checks = true to accept this",
      fix: config.workflow.allow_no_required_checks
        ? "Add the names of the CI checks that must pass to workflow.required_checks"
        : "Add the names of the CI checks that must pass to workflow.required_checks, or set workflow.allow_no_required_checks = true",
    });
  }

  const rules = config.contract.extra_rules;
  if (rules !== undefined) {
    // A configured file that does not exist is almost always a typo.
    findings.push(
      existsSync(join(root, rules))
        ? { check: "contract.extra_rules", level: "ok", message: `contract.extra_rules: ${rules} found`, fix: "" }
        : {
            check: "contract.extra_rules",
            level: "error",
            message: `contract.extra_rules: ${rules} not found`,
            fix: `Create ${rules} or correct or remove contract.extra_rules`,
          },
    );
  }

  return findings;
}
