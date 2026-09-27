# gdt

**GitHub issues to merge-ready pull requests, with a developer, tester and reviewer agent.**

> Status: early development (0.x), used daily on this repository (see
> [docs/dogfooding.md](docs/dogfooding.md)). Background:
> [docs/design.md](docs/design.md).

gdt takes one GitHub issue and runs it through three independent agent roles
until a single draft pull request is ready to merge, or until it needs your
decision:

- the **developer** implements the issue and opens a draft pull request;
- the **tester** checks every acceptance criterion against the running code;
- the **reviewer** reads the diff against the issue.

A deterministic **supervisor** (plain code, no model) decides whose turn it is.
Waiting, polling and deciding cost no model tokens; a model only runs during a
role's turn. You drive gdt by talking to any coding agent (Claude Code, Codex,
OpenCode, MCode, pi or omp) and can watch the roles work in
[herdr](https://herdr.dev). **You always merge yourself**: gdt never merges,
deploys or closes issues.

## How it works

### The big picture

```text
 ┌──────────┐  "pick up issue 251     ┌──────────────────────┐
 │   you    │ ──────────────────────► │  operator agent      │  Claude Code, Codex,
 └──────────┘   with gdt"             │  (your chat session) │  OpenCode, ...
      ▲                               └──────────┬───────────┘
      │                                          │ gdt start 251   (returns at once)
      │                                          │ gdt wait 251    (background, 0 tokens)
      │                                          ▼
      │                     ┌──────────────────────────────────────────┐
      │                     │ supervisor  (deterministic, no model)    │
      │                     │  reads GitHub every poll_seconds,        │
      │                     │  decides the next turn, enforces gates   │
      │                     └───────┬──────────────┬──────────────┬────┘
      │                     dispatch│      dispatch│      dispatch│
      │                             ▼              ▼              ▼
      │                     ┌────────────┐  ┌────────────┐  ┌────────────┐
      │                     │ developer  │  │  tester    │  │  reviewer  │
      │                     │  worker    │  │  worker    │  │  worker    │
      │                     └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
      │                           │ one turn      │ one turn      │ one turn
      │                           ▼               ▼               ▼
      │                     ┌──────────────────────────────────────────┐
      │                     │ GitHub: issue #251 + one draft PR        │
      │                     │  code, commits and [gdt-*:v1] records    │
      │                     └──────────────────────────────────────────┘
      │
      └──── notification + `gdt wait` returns on:
            awaiting_human │ blocked │ failed │ ready_to_merge
```

- The **operator** is the agent you already chat with. It only runs `gdt`
  commands and relays your words; it never writes code in the workflow.
- The **supervisor** runs as its own process (a herdr pane or a detached
  process), so closing or compacting your chat never stops a workflow.
- Each **worker** waits for a dispatch without using a model, runs exactly one
  agent turn (for example `claude -p ...`), and goes back to waiting.
- Roles talk to each other only through **records** posted as comments on
  GitHub (`[gdt-handoff:v1]`, `[gdt-test:v1]`, `[gdt-review:v1]`, ...). The
  supervisor reads those records; nothing is passed by chat.

### One issue, start to finish

```text
  write the issue ──► gdt check-issue 251 ──► invalid: fix the body, check again
                             │ valid
                             ▼
   ┌──────────────────────────────────────────────────────────┐
   │ gdt start 251                                            │
   │ preflight: config valid, clean working tree, contract ok │
   └────────┬─────────────────────────────────────────────────┘
            ▼
   ┌──────────────────────────────────────────────────────────┐
   │ developer (round 0): branch, implement the ACs, tests,   │◄──────┐
   │ draft PR with "Closes #251", post [gdt-handoff:v1]       │       │
   └────────┬─────────────────────────────────────────────────┘       │
            ▼                                                         │
   ┌──────────────────────┐                                           │
   │ tester (read-only)   │  checks every AC on the PR head           │
   │ post [gdt-test:v1]   ├── changes_requested ──┐                   │
   └────────┬─────────────┘                       │                   │
            │ approved                            ▼                   │
   ┌──────────────────────┐            ┌─────────────────────┐  yes   │
   │ reviewer (read-only) │            │ correction rounds   ├────────┘
   │ post [gdt-review:v1] ├── changes ►│ left?               │ developer fixes
   └────────┬─────────────┘  requested └─────────┬───────────┘ (round 1, 2, ...)
            │ approved                           │ no
            ▼                                    ▼
   ┌─────────────────────────────┐     ┌─────────────────────┐
   │ gates                       │     │ blocked             │
   │ - every AC passed by both   │     │ you decide:         │
   │ - no blocking findings      │     │ gdt allow-round 251 │
   │ - no merge conflict         │     └─────────────────────┘
   │ - required CI checks green  │
   └────────┬────────────────────┘
            │ all pass
            ▼
   ┌─────────────────────────────┐
   │ ready_to_merge              ├──► you review and merge the PR
   └─────────────────────────────┘    ("Closes #251" closes the issue)

  At any point a role may post [gdt-question:v1] → status awaiting_human
  → you answer through the operator (gdt answer 251 Q1 "...") → that role resumes.
```

Evidence is bound to the exact pull request head: when the developer pushes a
new commit, earlier test and review results no longer count and the tester and
reviewer run again. Editing the issue body (with a Changelog entry) resets all
evidence too.

## Requirements

| Tool | Why |
|---|---|
| Node 24 LTS | runs gdt |
| `git` | the shared checkout the roles work in |
| `gh`, logged in (`gh auth login`) | issues, pull requests, comments, checks |
| at least one agent CLI | `claude`, `codex`, `opencode`, `mcode`, `pi` or `omp` (see below) |
| CI on pull requests | the target repository needs at least one CI check (for example a GitHub Actions job); `workflow.required_checks` lists its name as shown on the pull request and `gdt init` detects the names. Set `workflow.allow_no_required_checks = true` only as the explicit opt-out |
| [herdr](https://herdr.dev) 0.9.1+ | the default way to watch the roles live, one tab per role; on machines without herdr set `workflow.terminal = "headless"` |

### Agent prerequisites

Before the first `gdt start`, every agent CLI you name in the user config
(`~/.config/gdt/config.toml`) must already work on your machine with the exact
model id you set there. For each role:

1. install the agent CLI,
2. log in or configure its API key or subscription,
3. run it once successfully with the model id from `roles.<role>.model` (for
   example `opencode/deepseek/deepseek-v4-flash`).

gdt runs the agent CLI as is, so the agent uses its own login, tokens and
credits. gdt stores no credentials and does not log in, choose a plan, or track
token use or costs. `gdt doctor` only checks that the CLI is on `PATH`, not that
its login, API key or model works.

## Install

```bash
npm i -g @gevezex/gdt
gdt --version
```

Or run it once without installing: `npx @gevezex/gdt doctor`.

From source instead:

```bash
git clone https://github.com/gevezex/gdt.git
cd gdt
npm ci
npm run build
npm link          # puts `gdt` on your PATH
```

A linked install runs `dist/` of that checkout, so gdt runs the code you built
there. A workflow that runs gdt on that same checkout (for example on gdt's own
repository) can rebuild `dist/` and change the running gdt mid-workflow. Use a
linked install only to develop gdt; to run workflows, install the published
package with `npm i -g @gevezex/gdt`.

Then install the operator skill, so your coding agent knows how to drive gdt:

```bash
gdt install-skill
```

It copies `skill/SKILL.md` into the skill directory of every agent CLI it finds
(for example `~/.claude/skills/gdt`) and is safe to run again.

## Security

Before the first `gdt start`, know what a role turn can do:

- Every role turn runs its agent CLI **without permission prompts** and with
  shell access to the machine. The adapters pass, for example,
  `--permission-mode bypassPermissions` for Claude Code and
  `--dangerously-bypass-approvals-and-sandbox` for Codex, because nobody is
  there to answer a prompt. Run gdt only where you accept that.
- Issue and comment text is **task data** for the roles, never instructions to
  the supervisor. Treat an issue body or a comment as untrusted input.
- The tester and reviewer are **checked mechanically**: after their turn the
  supervisor verifies that HEAD, branch and the tracked files are unchanged, and
  blocks the workflow otherwise.
- Roles act with **your own `gh` login**. An agent-written comment is
  indistinguishable from one you wrote; gdt never merges, deploys or closes
  issues.

The full invocation for each agent is in [docs/agents.md](docs/agents.md); the
trust boundaries are in
[section 10 of docs/design.md](docs/design.md#10-security-and-trust-boundaries).

## Quick start

### 1. Set up the user config once per machine

Roles belong to you, not to a repository, so they live in your user config. Ask
your coding agent, or run `gdt init` yourself:

```bash
gdt init --developer opencode/deepseek/deepseek-v4-flash \
         --tester claude/claude-sonnet-5 \
         --reviewer codex/gpt-5.6-luna
```

`gdt init` writes the roles to the user config (`~/.config/gdt/config.toml`, or
`$XDG_CONFIG_HOME/gdt/config.toml`) and installs the operator skill. Run it from
one of your checkouts: it also creates that repository's `.gdt/config.toml`, so
that first repository is configured too. Without the three role options, it
reuses the roles from your user config when they are all there; otherwise it
only reports what it found (agents on `PATH`, the terminal, the detected CI
checks) so your agent can discuss the roles with you first. It never overwrites
an existing config without `--force`.

### 2. Configure each target repository

For every other repository you want gdt to work on, create `.gdt/config.toml`
with `gdt init` (no role options: it reuses the roles from your user config), or
commit a file based on [`examples/config.toml`](examples/config.toml). `gdt init`
requires at least one required check unless you pass
`--allow-no-required-checks`.

Then check your setup in that repository:

```bash
gdt doctor
```

`doctor` checks `git`, `gh` and its login, the agent CLIs, herdr (when used) and
the user, repository and local config, and prints a `fix:` line for every
problem. It also warns when developer and tester use the same model vendor,
because the tester is less independent then.

### 3. Write the issue as a contract

The issue body is the only specification. It needs fixed sections and numbered
acceptance criteria, each with Given, When, Then and a concrete Example:

```markdown
## Plain language
One paragraph for humans.

## Goal
## Context
## Definitions

## Acceptance criteria

**AC-1: Short title**

- Given: the starting situation
- When: the action
- Then: the observable result
- Example: `gdt foo 12` prints `bar`

## Non-functional
## Out of scope
## Assumptions

## Open questions

None.

## Changelog
- 2026-09-27: first version

## Readiness
```

Work starts only when `Open questions` is exactly `None.` Vague phrases such as
"robust" or "etc." are rejected. Headings come from
[`locales/<language>.toml`](locales), so a Dutch issue uses `Acceptatiecriteria`,
`Gegeven`, `Wanneer` and so on. Check an issue before starting:

```bash
gdt check-issue 251                    # an existing issue
gdt check-issue --body-file body.md    # a draft, without calling GitHub
```

Your agent can help write the body with the issue-writer instructions in
[`roles/issue-writer.md`](roles/issue-writer.md).

### 4. Start it from your agent

Just ask your coding agent, in your own language:

> pick up issue 251 with gdt

The agent runs `gdt start 251` and then `gdt wait 251` in the background. You
get a desktop notification when something needs you. Come back to the same
chat and ask "what's going on?".

You can also run it by hand:

```bash
gdt start 251     # starts the supervisor and workers, returns immediately
gdt wait 251      # blocks until the workflow needs attention
gdt status 251    # one line plus the next step
```

### 5. Answer, steer, merge

| Situation | What you (or your agent) run |
|---|---|
| A role asks a question | `gdt answer 251 Q1 "use the existing config file"` |
| You want to guide one role | `gdt steer 251 --role developer "keep the public API unchanged"` |
| Round budget used up | `gdt allow-round 251` |
| A turn failed or crashed | `gdt retry 251`, then `gdt start 251` |
| Try another model for a role | `gdt set-agent 251 tester claude/claude-opus-5-5` |
| `ready_to_merge` | review the draft PR, mark it ready and merge it yourself |

The operator only posts answers and directives in your words, or after you
confirmed the text. Directives are guidance, not contract: a directive that
changes product behaviour makes the role ask for the issue body to be updated.

## Workflow statuses

`gdt status <n>` always prints the status and the next step.

| Status | Meaning | Next step |
|---|---|---|
| `starting` / `running` | a role turn is running | wait |
| `waiting_for_checks` | approved; CI or mergeability pending | wait |
| `awaiting_human` | a role asked a question | `gdt answer <n> <question-id> "<text>"` |
| `blocked` | a gate failed or a role reported blocked; the reason says why | follow the hint, e.g. `gdt allow-round <n>` |
| `contract_changed` | the issue body changed; evidence is reset | wait |
| `failed` | an agent turn exited non-zero | `gdt retry <n>`, then `gdt start <n>` |
| `paused` / `stopped` | you paused or stopped it | `gdt resume <n>` / `gdt start <n>` |
| `ready_to_merge` | all gates passed | review and merge the PR |

## Commands

Every command supports `--help`; `status` and `wait` also support `--json`.

| Command | Effect |
|---|---|
| `gdt init` | Write the roles to the user config and `.gdt/config.toml`, install the operator skill |
| `gdt doctor` | Check tools, GitHub login, agents, herdr and the user, repository and local config |
| `gdt check-issue <n>` | Validate an issue body against the contract |
| `gdt start <n>` | Preflight, start the supervisor and workers, return |
| `gdt status <n>` | Status, role, round, open findings and next step |
| `gdt wait <n>` | Block (without tokens) until the workflow needs attention |
| `gdt stop <n>` | Stop everything; `gdt start` resumes the same workflow |
| `gdt pause <n>` / `gdt resume <n>` | Stop / continue dispatching new turns |
| `gdt answer <n> <id> <text>` | Answer an open question |
| `gdt steer <n> --role <role> <text>` | Send a directive to one role's next turn |
| `gdt allow-round <n>` | Grant one extra correction round |
| `gdt retry <n>` | Clear a failed or interrupted turn so it runs again |
| `gdt set-agent <n> <role> <agent>/<model>` | Override one role's agent for this issue |
| `gdt install-skill` | Install the operator skill into your agent CLIs |

## Configuration

Roles belong to a person, not to a repository, so gdt keeps them in a per-user
config. gdt loads three files and merges them in this order, with the later file
winning per key:

1. the **user config** — `$XDG_CONFIG_HOME/gdt/config.toml`, or
   `~/.config/gdt/config.toml` when `XDG_CONFIG_HOME` is not set. It holds only
   `[roles.*]`. A relative `XDG_CONFIG_HOME` is ignored.
2. the **repository config** — `.gdt/config.toml`, committed. It holds the project
   settings and must not contain `[roles.*]`.
3. the **local config** — `.gdt/config.local.toml`, never committed. It overrides
   any key, for example one role's model on this machine.

`gdt init` writes the roles to the user config and the project settings to
`.gdt/config.toml`. Ready-made files are in [`examples/`](examples/):
[`examples/user-config.toml`](examples/user-config.toml),
[`examples/config.toml`](examples/config.toml) and
[`examples/config.local.toml`](examples/config.local.toml).

| Key | File | Default | Meaning |
|---|---|---|---|
| `roles.<role>.agent` | user | required | `claude`, `codex`, `opencode`, `mcode`, `pi` or `omp` |
| `roles.<role>.model` | user | required | Model id for that agent |
| `language` | repository | `"en"` | Language of issue and PR text (`en`, `nl`) |
| `workflow.required_checks` | repository | required | CI checks that must be green before `ready_to_merge` |
| `workflow.allow_no_required_checks` | repository | `false` | Allow an empty `required_checks` list |
| `workflow.max_correction_rounds` | repository | `2` | Correction rounds after round 0 |
| `workflow.terminal` | repository | `"herdr"` | `"herdr"` or `"headless"` |
| `workflow.supervisor_pane` | repository | `false` | herdr: also show the supervisor in a pane |
| `workflow.herdr_layout` | repository | `tabs` | herdr: `"tabs"` (one tab per pane) or `"split"` (panes side by side in one tab) |
| `workflow.poll_seconds` | repository | `30` | How often the supervisor reads GitHub |
| `contract.max_acceptance_criteria` | repository | `8` | Maximum number of ACs per issue |
| `contract.extra_rules` | repository | none | File with project rules added to every role prompt |

### Per-role rules

Each workflow role can have supplementary rules of its own, in the target repository:

| File | Role |
|---|---|
| `.gdt/roles/developer.md` | developer |
| `.gdt/roles/tester.md` | tester |
| `.gdt/roles/reviewer.md` | reviewer |

When a file has content, gdt appends it to that role's prompt on every turn under a
`## Role rules` heading, after `## Project rules` when `contract.extra_rules` sets one.
An empty or missing file adds nothing and is not an error. This only adds: gdt's own role
files in the package are never replaced, so the protocol stays intact. `gdt init` creates
the three files empty so you can see where your rules go; commit them like
`.gdt/config.toml`.

How each agent CLI is invoked is documented in [docs/agents.md](docs/agents.md).

## Upgrading

### From 0.3 to 0.4

Since 0.4.0, `[roles.*]` in `.gdt/config.toml` is an error and `gdt start`
refuses to run. Roles now live in the user config. To upgrade:

1. Move the three `[roles.*]` tables from `.gdt/config.toml` to the user config
   at `~/.config/gdt/config.toml`, or `$XDG_CONFIG_HOME/gdt/config.toml` when
   `XDG_CONFIG_HOME` is set.
2. Remove the `[roles.*]` tables from `.gdt/config.toml`, so only the repository
   settings (`[workflow]`, `[contract]`) remain.
3. Run `gdt doctor` to check that the configuration is valid again.

Instead of steps 1 and 2 you can run `gdt init --force` with the three role
options (see [Quick start](#quick-start)). It writes the roles to the user
config, but it also replaces `.gdt/config.toml` in the current checkout with
freshly detected defaults, so any custom repository settings there are lost.
Use the manual move when you have changed `[workflow]` or `[contract]`.

## Watching it: herdr or headless

```text
 herdr workspace "gdt-251"                        headless
 ┌────────────┐ ┌────────────┐ ┌────────────┐
 │ developer  │ │ tester     │ │ reviewer   │   detached processes,
 │ opencode · │ │ claude ·   │ │ codex ·    │   one log file each in
 │ RUNNING    │ │ WAITING    │ │ WAITING    │   .git/gdt/issue-251/logs/
 └────────────┘ └────────────┘ └────────────┘
   one tab per role, labelled developer, tester and reviewer
   supervisor runs detached → logs/supervisor.log
```

Everything gdt keeps for an issue lives under `.git/gdt/issue-<n>/`: `state.json`
(the workflow state), `logs/` (one log per process) and `runs/` (the prompt and
result of every turn). It is never committed.

### Notifications

When a workflow needs you, gdt notifies you through the first of
`terminal-notifier`, `osascript` (macOS) or `notify-send` (Linux) that is on
`PATH` and works. If none of them is available, the notification is only
written to `.git/gdt/issue-<n>/logs/supervisor.log`, and `gdt wait` is the way
to be told: it blocks until the workflow needs attention.

## The checkout during and after a workflow

The roles work in the checkout where you run `gdt start`: the developer checks
out the feature branch there, and the tester and reviewer read that same working
tree. `gdt start` needs a **clean working tree** and refuses to run otherwise
("Commit or stash before starting."), so commit or stash first. Do not edit that
checkout while a workflow runs; if you want to keep working, use a separate
clone for gdt.

After `ready_to_merge`, or after `gdt stop`, two things stay behind:

- the herdr workspace `gdt-<n>`, which you can close yourself in herdr;
- the state directory `.git/gdt/issue-<n>/`, which you may delete once the pull
  request is merged and no gdt process for that issue is running.

## Troubleshooting

When a turn fails or a workflow stops unexpectedly, start with:

```bash
gdt status <n>
gdt doctor
```

`gdt status <n>` shows the status, role, round and next step; `gdt doctor`
reports a `fix:` line for every configuration or tool problem.

Everything gdt keeps for an issue is under the state directory: one log per
process in `.git/gdt/issue-<n>/logs/`, and the prompt and result of every turn
in `.git/gdt/issue-<n>/runs/`.

- **exit code 78** means the configuration was invalid or the turn's prompt
  could not be built. Run `gdt doctor`, fix what it reports, then
  `gdt retry <n>` and `gdt start <n>`.
- **any other non-zero exit code** means the agent CLI itself failed; its log
  under `.git/gdt/issue-<n>/logs/` shows why.

## Principles

- **The issue body is the contract.** Work starts only when there are no open questions.
- **Independent verification.** The tester derives its checks from the contract,
  not from the developer's claims. Evidence is bound to the exact PR head.
- **Bounded cost.** A fixed correction-round budget; models run only on dispatched turns.
- **Fail closed.** When a trustworthy decision is impossible, gdt stops and tells you why.
- **Role boundaries are checked.** After a tester or reviewer turn, the supervisor
  verifies that HEAD, branch and tracked files are unchanged.
- **Your language on GitHub.** Issues and PR text in your configured language;
  protocol, code and CLI output in English.
- **Humans merge.** gdt never merges, deploys or closes issues.

## Development

Requires Node 24 LTS.

```bash
npm ci
npm run build
npm run lint
npm test
node dist/cli.js doctor   # run in a repository configured for gdt (user + repository + local config)
```

Rules for agents working on this repository: [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
