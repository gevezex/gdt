import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml, TomlError } from "smol-toml";
import { z } from "zod";
import type { Finding } from "./finding.js";

export const AGENTS = ["claude", "codex", "opencode", "mcode", "pi", "omp"] as const;
export const ROLES = ["developer", "tester", "reviewer"] as const;
export const TERMINALS = ["herdr", "headless"] as const;

export const CONFIG_PATH = ".gdt/config.toml";
export const LOCAL_CONFIG_PATH = ".gdt/config.local.toml";

export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_MAX_ACCEPTANCE_CRITERIA = 8;

export type Agent = (typeof AGENTS)[number];
export type Role = (typeof ROLES)[number];

const roleSchema = z.strictObject({
  agent: z.enum(AGENTS),
  model: z.string().min(1),
});

export const configSchema = z.strictObject({
  language: z.string().min(1).default(DEFAULT_LANGUAGE),
  roles: z.strictObject({
    developer: roleSchema,
    tester: roleSchema,
    reviewer: roleSchema,
  }),
  workflow: z.strictObject({
    max_correction_rounds: z.int().min(0).default(2),
    // Deliberately without a default: an empty gate must be an explicit choice.
    required_checks: z.array(z.string().min(1)),
    allow_no_required_checks: z.boolean().default(false),
    terminal: z.enum(TERMINALS).default("herdr"),
  }),
  contract: z
    .strictObject({
      max_acceptance_criteria: z.int().min(1).default(DEFAULT_MAX_ACCEPTANCE_CRITERIA),
      extra_rules: z.string().min(1).optional(),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;

export interface ResolvedRole {
  agent: Agent;
  model: string;
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

interface Layer {
  path: string;
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

/** The layer that supplied the value at `path`, preferring the local override. */
function sourceOf(layers: readonly Layer[], path: readonly PropertyKey[]): string {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer && valueAt(layer.data, path) !== undefined) return layer.path;
  }
  return layers[0]?.path ?? CONFIG_PATH;
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

function readLayer(root: string, path: string): Layer | Finding {
  const text = readFileSync(join(root, path), "utf8");
  try {
    return { path, data: parseToml(text) };
  } catch (err) {
    const where = err instanceof TomlError ? ` at line ${err.line}, column ${err.column}` : "";
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return {
      check: "config",
      level: "error",
      message: `${path}: invalid TOML${where}: ${reason}`,
      fix: `Fix the TOML syntax in ${path}`,
    };
  }
}

/** Loads, merges and validates `.gdt/config.toml` and `.gdt/config.local.toml` in `root`. */
export function loadConfig(root: string): { report: ConfigReport; findings: Finding[] } {
  const files = [CONFIG_PATH, LOCAL_CONFIG_PATH].filter((path) => existsSync(join(root, path)));

  if (!files.includes(CONFIG_PATH)) {
    return {
      report: { valid: false, files },
      findings: [
        {
          check: "config",
          level: "error",
          message: `${CONFIG_PATH}: not found`,
          fix: `Create ${CONFIG_PATH}; example: https://github.com/gevezex/gdt/blob/main/docs/design.md#4-configuration-per-target-repository`,
        },
      ],
    };
  }

  const layers: Layer[] = [];
  const findings: Finding[] = [];
  for (const path of files) {
    const layer = readLayer(root, path);
    if ("data" in layer) layers.push(layer);
    else findings.push(layer);
  }
  if (findings.length > 0) return { report: { valid: false, files }, findings };

  const merged = layers.reduce<Table>((acc, layer) => merge(acc, layer.data), {});
  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    return {
      report: { valid: false, files },
      findings: parsed.error.issues.flatMap((issue) => issueFindings(issue, merged, layers)),
    };
  }

  const config = parsed.data;
  const roles = Object.fromEntries(
    ROLES.map((role) => {
      const localRole = layers.length > 1 ? valueAt(layers[layers.length - 1]?.data, ["roles", role]) : undefined;
      const source = isTable(localRole) && Object.keys(localRole).length > 0 ? LOCAL_CONFIG_PATH : CONFIG_PATH;
      return [role, { ...config.roles[role], source }];
    }),
  ) as Record<Role, ResolvedRole>;

  findings.push({
    check: "config",
    level: "ok",
    message: files.length > 1 ? `${CONFIG_PATH} is valid, with overrides from ${LOCAL_CONFIG_PATH}` : `${CONFIG_PATH} is valid`,
    fix: "",
  });
  findings.push(...semanticFindings(root, config));

  return { report: { valid: true, files, ...config, roles }, findings };
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
