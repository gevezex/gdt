import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readme(): string {
  return readFileSync("README.md", "utf8");
}

/** The README text from `start` up to `end` (or the end of the file). */
function section(text: string, start: string, end?: string): string {
  const from = text.indexOf(start);
  expect(from, `missing heading ${start}`).toBeGreaterThanOrEqual(0);
  const to = end === undefined ? text.length : text.indexOf(end, from);
  expect(to, `missing heading ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

/** Whitespace-collapsed, so tests do not depend on the hard wrapping. */
function collapsed(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("AC-1: upgrade note from 0.3 to 0.4", () => {
  it("has an Upgrading section with a 0.3 to 0.4 note that names the user config and gdt doctor", () => {
    const upgrading = section(readme(), "## Upgrading");

    expect(upgrading).toContain("### From 0.3 to 0.4");

    const note = collapsed(upgrading.slice(upgrading.indexOf("### From 0.3 to 0.4")));
    expect(note).toContain("[roles.*]");
    expect(note).toContain(".gdt/config.toml");
    expect(note).toContain("is an error");
    expect(note).toContain("refuses to run");
    expect(note).toContain("~/.config/gdt/config.toml");
    expect(note).toContain("gdt init --force");
    expect(note).toContain("gdt doctor");
  });

  it("gives a safe manual move and warns that the --force alternative replaces the repository config", () => {
    const upgrading = section(readme(), "## Upgrading");
    const note = collapsed(upgrading.slice(upgrading.indexOf("### From 0.3 to 0.4")));

    expect(note).toMatch(/Move the three `\[roles\.\*\]` tables/);
    expect(note).toMatch(/replaces `.gdt\/config\.toml` in the current checkout with freshly detected defaults/);
    expect(note).toMatch(/custom repository settings there are lost/);
    expect(note).toMatch(/manual move when you have changed/);
  });
});

describe("AC-2: stale passages match 0.4", () => {
  it("splits Quick start step 1 into the user config and the target repository", () => {
    const quickStart = collapsed(section(readme(), "## Quick start", "## Workflow statuses"));
    expect(quickStart).toMatch(/### 1\. Set up the user config once per machine/);
    expect(quickStart).toMatch(/### 2\. Configure each target repository/);
    expect(quickStart).toContain("~/.config/gdt/config.toml");
  });

  it("says step 1 also configures that first checkout, so step 2 is for the other repositories", () => {
    const quickStart = collapsed(section(readme(), "## Quick start", "## Workflow statuses"));

    expect(quickStart).toMatch(/also creates that repository's `\.gdt\/config\.toml`/);
    expect(quickStart).toMatch(/so that first repository is configured too/);
    expect(quickStart).toMatch(/For every other repository you want gdt to work on/);
    expect(quickStart).toMatch(/no role options: it reuses the roles from your user config/);
  });

  it("names the user, repository and local config in the Commands doctor row", () => {
    const commands = section(readme(), "## Commands", "## Configuration");
    expect(collapsed(commands)).toContain(
      "| `gdt doctor` | Check tools, GitHub login, agents, herdr and the user, repository and local config |",
    );
  });

  it("no longer says a repository only needs .gdt/config.toml in Development", () => {
    const development = section(readme(), "## Development", "## License");
    expect(development).not.toContain("run inside a repository with .gdt/config.toml");
    expect(development).toContain("user + repository + local config");
  });

  it("gives gdt retry and then gdt start as the next step for failed", () => {
    const statuses = section(readme(), "## Workflow statuses", "## Commands");
    expect(statuses).toContain("| `failed` | an agent turn exited non-zero | `gdt retry <n>`, then `gdt start <n>` |");
  });
});

describe("AC-3: warning about linked installs", () => {
  it("warns that a linked install runs dist/ of that checkout and points to the published package", () => {
    const install = section(readme(), "## Install", "## Security");
    const afterLink = collapsed(install.slice(install.indexOf("npm link")));

    expect(afterLink).toContain("dist/");
    expect(afterLink).toContain("npm i -g @gevezex/gdt");
    expect(afterLink).toMatch(/linked install only to develop gdt/i);
  });
});

describe("AC-4: security section", () => {
  it("warns about unattended runs and names the example permission flags", () => {
    const security = collapsed(section(readme(), "## Security", "## Quick start"));
    expect(security).toContain("bypassPermissions");
    expect(security).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(security).toMatch(/without permission prompts/i);
    expect(security).toContain("shell access to the machine");
  });

  it("states the trust boundaries and links to the docs", () => {
    const security = collapsed(section(readme(), "## Security", "## Quick start"));
    expect(security).toMatch(/task data/i);
    expect(security).toContain("HEAD, branch and the tracked files are unchanged");
    expect(security).toContain("your own `gh` login");
    expect(security).toContain("docs/agents.md");
    expect(security).toContain("docs/design.md#10-security-and-trust-boundaries");
  });
});

describe("AC-5: the checkout during and after a workflow", () => {
  it("says the roles work where gdt start runs and that gdt start needs a clean working tree", () => {
    const checkout = collapsed(section(readme(), "## The checkout during and after a workflow", "## Troubleshooting"));
    expect(checkout).toContain("clean working tree");
    expect(checkout).toContain("checkout where you run `gdt start`");
    expect(checkout).toMatch(/developer checks out the feature branch/);
    expect(checkout).toContain("separate clone");
  });

  it("says what stays behind, including deleting the state directory after the merge", () => {
    const checkout = collapsed(section(readme(), "## The checkout during and after a workflow", "## Troubleshooting"));
    expect(checkout).toContain("`gdt-<n>`");
    expect(checkout).toContain("`.git/gdt/issue-<n>/`");
    expect(checkout).toMatch(/delete once the pull request is merged/);
  });
});

describe("AC-6: a CI check is required", () => {
  it("has a Requirements row that requires at least one CI check and names the keys", () => {
    const requirements = section(readme(), "## Requirements", "## Install");
    const row = requirements.split("\n").find((line) => line.includes("workflow.required_checks"));

    expect(row, "no Requirements row mentions workflow.required_checks").toBeDefined();
    expect(row).toContain("allow_no_required_checks");
    expect(row).toMatch(/at least one CI check/i);
    expect(row).toMatch(/GitHub Actions job/);
    expect(row).toMatch(/gdt init`? detects the names/);
  });
});

describe("AC-7: troubleshooting section", () => {
  it("points at status and doctor, names logs/ and runs/, and explains exit code 78", () => {
    const troubleshooting = collapsed(section(readme(), "## Troubleshooting", "## Principles"));

    expect(troubleshooting).toContain("gdt status <n>");
    expect(troubleshooting).toContain("gdt doctor");
    expect(troubleshooting).toContain("`.git/gdt/issue-<n>/logs/`");
    expect(troubleshooting).toContain("`.git/gdt/issue-<n>/runs/`");
    expect(troubleshooting).toContain("exit code 78");
    expect(troubleshooting).toContain("configuration was invalid or the turn's prompt could not be built");
    expect(troubleshooting).toContain("gdt retry <n>");
    expect(troubleshooting).toContain("gdt start <n>");
    expect(troubleshooting).toMatch(/any other non-zero exit code.*agent CLI itself failed/i);
  });
});

describe("AC-8: notifications per platform", () => {
  it("names the notifier fallback chain and the supervisor log in one paragraph", () => {
    const watching = section(readme(), "## Watching it: herdr or headless", "## The checkout during and after a workflow");
    const notifications = section(watching, "### Notifications");

    const paragraph = notifications
      .split(/\n\s*\n/)
      .find((block) => block.includes("notify-send") && block.includes("supervisor.log"));

    expect(paragraph, "no single paragraph mentions notify-send and supervisor.log").toBeDefined();
    const text = collapsed(paragraph ?? "");
    expect(text).toContain("terminal-notifier");
    expect(text).toContain("osascript");
    expect(text).toContain("notify-send");
    expect(text).toContain("supervisor.log");
    expect(text).toContain("gdt wait");
  });
});
