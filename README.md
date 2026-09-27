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
| [herdr](https://herdr.dev) 0.9.1+ | the default way to watch the roles live, one tab per role; on machines without herdr set `workflow.terminal = "headless"` |

### Agent prerequisites

Before the first `gdt start`, every agent CLI you name in `.gdt/config.toml` must
already work on your machine with the exact model id you set there. For each
role:

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

Then install the operator skill, so your coding agent knows how to drive gdt:

```bash
gdt install-skill
```

It copies `skill/SKILL.md` into the skill directory of every agent CLI it finds
(for example `~/.claude/skills/gdt`) and is safe to run again.

## Quick start

### 1. Configure the target repository

In the repository you want gdt to work on, create `.gdt/config.toml` with
`gdt init` instead of writing TOML by hand. Ask your coding agent, or run it
yourself:

```bash
gdt init --developer opencode/deepseek/deepseek-v4-flash \
         --tester claude/claude-sonnet-5 \
         --reviewer codex/gpt-5.6-luna
```

`gdt init` writes the config, runs `gdt doctor` and installs the operator skill.
Without the three role options it only reports what it found (agents on `PATH`,
the terminal, the detected CI checks) so your agent can discuss the roles with
you first. It never overwrites an existing config without `--force`, and it
requires at least one required check unless you pass `--allow-no-required-checks`.

Then check your setup:

```bash
gdt doctor
```

`doctor` checks `git`, `gh` and its login, the agent CLIs, herdr (when used)
and the config, and prints a `fix:` line for every problem. It also warns when
developer and tester use the same model vendor, because the tester is less
independent then.

### 2. Write the issue as a contract

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

### 3. Start it from your agent

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

### 4. Answer, steer, merge

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
| `failed` | an agent turn exited non-zero | `gdt retry <n>` |
| `paused` / `stopped` | you paused or stopped it | `gdt resume <n>` / `gdt start <n>` |
| `ready_to_merge` | all gates passed | review and merge the PR |

## Commands

Every command supports `--help`; `status` and `wait` also support `--json`.

| Command | Effect |
|---|---|
| `gdt init` | Create `.gdt/config.toml` and install the operator skill |
| `gdt doctor` | Check tools, GitHub login, agents, herdr and `.gdt/config.toml` |
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

`.gdt/config.toml` is committed; `.gdt/config.local.toml` holds machine-local
overrides (for example another model) and is not committed.

| Key | Default | Meaning |
|---|---|---|
| `language` | `"en"` | Language of issue and PR text (`en`, `nl`) |
| `roles.<role>.agent` | required | `claude`, `codex`, `opencode`, `mcode`, `pi` or `omp` |
| `roles.<role>.model` | required | Model id for that agent |
| `workflow.required_checks` | required | CI checks that must be green before `ready_to_merge` |
| `workflow.allow_no_required_checks` | `false` | Allow an empty `required_checks` list |
| `workflow.max_correction_rounds` | `2` | Correction rounds after round 0 |
| `workflow.terminal` | `"herdr"` | `"herdr"` or `"headless"` |
| `workflow.supervisor_pane` | `false` | herdr: also show the supervisor in a pane |
| `workflow.herdr_layout` | `tabs` | herdr: `"tabs"` (one tab per pane) or `"split"` (panes side by side in one tab) |
| `workflow.poll_seconds` | `30` | How often the supervisor reads GitHub |
| `contract.max_acceptance_criteria` | `8` | Maximum number of ACs per issue |
| `contract.extra_rules` | none | File with project rules added to every role prompt |

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
node dist/cli.js doctor   # run inside a repository with .gdt/config.toml
```

Rules for agents working on this repository: [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
