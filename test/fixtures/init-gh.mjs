// A stand-in for `gh` for the `gdt init` tests. Usage: node init-gh.mjs <config.json> <gh args...>
// It answers the two commands the proposal needs: the repo's default branch and the check runs and
// commit statuses on it. `gh auth status` succeeds so `gdt doctor` runs clean.
import { readFileSync } from "node:fs";
import process from "node:process";

const [file, ...args] = process.argv.slice(2);
const data = JSON.parse(readFileSync(file, "utf8"));

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const [a, b] = args;
if (a === "repo" && b === "view") {
  if (data.failRepo) fail("no GitHub remote");
  out({ nameWithOwner: data.repo, defaultBranchRef: { name: data.defaultBranch } });
} else if (a === "auth" && b === "status") {
  process.exit(data.failAuth ? 1 : 0);
} else if (a === "api") {
  const path = args[1] ?? "";
  if (path === `repos/${data.repo}`) out({ default_branch: data.defaultBranch });
  else if (path.includes("/check-runs")) out({ check_runs: (data.checks ?? []).map((name) => ({ name })) });
  else if (path.endsWith("/status")) out({ statuses: (data.statuses ?? []).map((context) => ({ context })) });
  else fail(`init-gh: unsupported api ${path}`);
} else {
  fail(`init-gh: unsupported command: ${args.join(" ")}`);
}
