export type Level = "ok" | "warning" | "error";

/** One doctor result. `fix` names the recovery action; empty when level is "ok". */
export interface Finding {
  check: string;
  level: Level;
  message: string;
  fix: string;
}

export function hasErrors(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.level === "error");
}
