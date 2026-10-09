import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

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

/**
 * #76: the directory a tester or reviewer turn for `head` runs in. That is `root` when it has `head`
 * checked out, otherwise the first other worktree at `head` whose directory exists, otherwise `root`.
 */
export function headWorktree(root: string, head: string, env: Env): string {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const main = real(root) ?? root;
  const atHead: string[] = [];
  for (const entry of git(["worktree", "list", "--porcelain"], root, env).split("\n\n")) {
    const fields = entry.split("\n");
    const path = fields.find((f) => f.startsWith("worktree "))?.slice("worktree ".length);
    if (path === undefined || !fields.includes(`HEAD ${head}`)) continue;
    const dir = real(path);
    if (dir !== null) atHead.push(dir);
  }
  if (atHead.includes(main)) return root;
  return atHead[0] ?? root;
}
