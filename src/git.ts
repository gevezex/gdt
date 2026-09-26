import { spawnSync } from "node:child_process";

type Env = Record<string, string | undefined>;

function git(args: readonly string[], cwd: string, env: Env): string {
  return spawnSync("git", args, { cwd, env, encoding: "utf8" }).stdout ?? "";
}

/** Paths from `git status --porcelain -z`; renames report the new path. */
export function changedFiles(root: string, env: Env, untracked: boolean): string[] {
  const entries = git(["status", "--porcelain", "-z", `--untracked-files=${untracked ? "all" : "no"}`], root, env).split("\0");
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    // A rename or copy is followed by its original path.
    if ("RC".includes(entry[0] ?? "") || "RC".includes(entry[1] ?? "")) i++;
  }
  return files;
}

export interface Checkout {
  head: string;
  /** Empty when HEAD is detached. */
  branch: string;
}

export function checkout(root: string, env: Env): Checkout {
  return {
    head: git(["rev-parse", "HEAD"], root, env).trim(),
    branch: git(["symbolic-ref", "--quiet", "--short", "HEAD"], root, env).trim(),
  };
}
