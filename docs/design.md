# gdt — design

Status: draft for review. Nothing here is implemented yet.

gdt runs a GitHub issue through three independent agent roles — **developer**,
**tester** and **reviewer** — until a single draft pull request is ready to
merge, or until a human decision is needed. A deterministic supervisor decides
whose turn it is. Any coding agent can operate it. herdr shows what is happening.

gdt is a clean rewrite. It borrows lessons from an earlier in-repo pilot but
carries no code, protocol versions or project-specific rules from it.

## 1. Goals and non-goals

Goals:

- **Low token use.** Waiting, polling and deciding cost zero model tokens. A model
  runs only when the supervisor dispatches a role turn.
- **Agent-agnostic.** The operator and each role can be Claude Code, Codex,
  OpenCode, MCode, pi or omp, configured per repository.
- **Human in the loop without memorising commands.** The user talks to an agent;
  the agent drives gdt through a small, agent-friendly CLI.
- **Fail closed.** When the supervisor cannot make a trustworthy decision, it
  stops and says why and what the recovery action is.
- **Native language on GitHub.** Issues, comments and PR bodies can be written in
  the user's language; everything machine-read stays in English.

Non-goals:

- Merging, deploying or closing issues. These are always explicit human actions.
- Replacing CI. gdt reads check results; it does not run a pipeline.
- Letting a model decide workflow gates.

## 2. Architecture

```
user ──► operator agent (any harness)
            │  "pick up issue 251 with gdt"
            ▼
         gdt start 251 ──────────── returns immediately
            │
            ▼
         herdr workspace "gdt-251"
         ┌────────────┬────────────┬────────────┬────────────┐
         │ supervisor │ developer  │ tester     │ reviewer   │
         │ (no model) │ worker     │ worker     │ worker     │
         └────────────┴────────────┴────────────┴────────────┘
            │
            └─► notification on awaiting_human / blocked / ready_to_merge
                    │
user ◄──────────────┘  back to the operator: "what's going on?"
```

Four parts, each with one job:

| Part | Job | Uses tokens |
|---|---|---|
| Operator agent | Talks to the user, runs gdt commands, explains status, troubleshoots | Only when the user talks to it |
| Supervisor | Deterministic state machine: reads GitHub, validates records, dispatches roles, enforces gates | Never |
| Role worker | Waits cheaply for a dispatch, runs one agent turn, reports the exit result | Only during a dispatched turn |
| Terminal backend | Makes the workflow visible (herdr) or runs it headless | Never |

### 2.1 Why the operator is not the supervisor

The supervisor enforces the issue-body hash, head-SHA binding of evidence, the
round budget, required checks and conflict state. These rules must hold on every
turn, survive session loss and cost nothing while waiting. A model-based
supervisor would spend tokens while waiting, can skip a check after context
compaction, dies with its session and would be both gatekeeper and the thing the
user steers. Steering is therefore a first-class feature of the supervisor
(section 5), invoked through the operator.

### 2.2 Hard rules for the operator

1. **The supervisor never runs as a child of the operator.** `gdt start` launches it
   in its own terminal-backend pane or detached process and returns. Closing or
   compacting the operator session never stops a workflow.
2. **No polling.** After starting, the operator goes idle. The supervisor
   notifies the user; the user returns to the operator.
3. **No invented answers.** The operator posts a human answer or directive only
   with the user's literal words or after the user explicitly confirmed the text.
   It never presents its own product choice as the user's answer.
4. **Hands off the working tree.** All roles share one checkout. The operator
   reads state and logs and runs gdt commands; code changes belong to the
   developer role.

Rule 3 cannot be enforced technically while roles, operator and user share one
GitHub account (see section 10, "Identity").

## 3. Technology and repository layout

TypeScript on Node (current LTS), published to npm as `@gevezex/gdt` with the
binary `gdt`. Most coding-agent CLIs are installed through npm, so Node is
already present for the target users. Install with `npm i -g @gevezex/gdt` or
run ad hoc with `npx @gevezex/gdt`. Tests use vitest; record and config schemas
are defined once in zod and exported as JSON Schema. Runtime dependencies stay
minimal; `gh` and `git` are called as subprocesses.

```
gdt/
  package.json              # name @gevezex/gdt, bin: { gdt }
  tsconfig.json
  src/
    cli.ts                  # subcommands, --json output, recovery hints
    config.ts               # .gdt/config.toml loading and validation
    contract.ts             # locale-aware issue-contract validator
    protocol.ts             # record markers, zod schemas, parsing
    decision.ts             # pure decision engine (no I/O)
    github.ts               # thin gh wrapper
    supervisor.ts           # loop, state, dispatch, notifications
    worker.ts               # role worker loop
    prompts.ts              # builds the per-turn role prompt
    backends/
      herdr.ts
      headless.ts
    agents/                 # one adapter per harness
      claude.ts codex.ts opencode.ts mcode.ts pi.ts omp.ts
    notify.ts
  roles/                    # English role instructions, injected per turn
    developer.md tester.md reviewer.md issue-writer.md
  skill/
    SKILL.md                # operator skill, installed into agent harnesses
  locales/
    en.toml nl.toml
  test/
  docs/
```

## 4. Configuration (per target repository)

One file, `.gdt/config.toml`, committed in the target repository:

```toml
language = "nl"                 # language for human-facing GitHub text

[roles.developer]
agent = "opencode"
model = "deepseek/deepseek-v4-flash"

[roles.tester]
agent = "claude"
model = "claude-sonnet-5"

[roles.reviewer]
agent = "codex"
model = "gpt-5.6-luna"

[workflow]
max_correction_rounds = 2       # Round 0 = first delivery, then corrections
required_checks = ["backend-tests", "frontend-checks"]
allow_no_required_checks = false
terminal = "herdr"              # "herdr" | "headless"

[contract]
max_acceptance_criteria = 8
extra_rules = ".gdt/rules.md"   # optional project rules appended to role prompts
```

- `extra_rules` is where project-specific invariants live (for example "a local
  match is no proof of external processing"). gdt itself ships none.
- `required_checks = []` refuses `ready_to_merge` unless
  `allow_no_required_checks = true`. An empty gate must never look like a green one.
- `gdt doctor` warns when developer and tester use the same model vendor, because
  correlated blind spots weaken the tester's independence.
- Local, uncommitted overrides (for example a different model on one machine) go
  in `.gdt/config.local.toml`, which gdt adds to `.git/info/exclude`.

Runtime state lives under `.git/gdt/issue-<n>/` and belongs to the supervisor
only.

## 5. CLI

Every command supports `--json`, and every error names the recovery action.
`status` always states the next step. The CLI is designed to be driven by an
agent, not memorised by a human.

| Command | Effect | Recorded in |
|---|---|---|
| `gdt doctor` | Checks gh auth, agents, models, herdr, config, skill install | — |
| `gdt check-issue <n>` | Validates the issue contract without starting anything | — |
| `gdt start <n>` | Preflight, creates the terminal workspace, starts the supervisor, returns | state |
| `gdt status [<n>] [--json]` | Status, current role, round, open findings, next step | — |
| `gdt logs <n> <role>` | Bounded tail of the role's last turn | — |
| `gdt answer <n> <question-id> <text>` | Posts a `human-answer` record | GitHub issue comment |
| `gdt steer <n> --role <role> <text>` | Posts a `human-directive`; included in that role's next turn | GitHub PR comment (issue comment before a PR exists) |
| `gdt pause <n>` / `gdt resume <n>` | Stops dispatching / resumes | state |
| `gdt retry <n>` | Prepares a controlled retry of the failed role turn | state |
| `gdt allow-round <n>` | Grants one extra correction round as an explicit user decision | GitHub comment + state |
| `gdt set-agent <n> <role> <agent>/<model>` | Changes the agent for that role from its next turn | state (overrides config for this issue) |
| `gdt stop <n>` | Stops supervisor and workers; `start` resumes | state |
| `gdt install-skill` | Installs the operator skill into detected harnesses | — |

Directives are guidance, not contract. A directive that changes product
behaviour is rejected by the role, which asks for the issue body to be updated
instead. A directive never counts as test or review evidence.

## 6. Language

Two layers with a hard boundary:

| Always English (machine) | Configured language (human) |
|---|---|
| Record markers, JSON keys, status values | Issue body text and headings |
| Role instructions and prompts | Prose below records in comments |
| CLI output and logs | PR body text and headings |
| gdt code, docs and tests | Questions and answers |

`locales/<lang>.toml` holds everything the validator must recognise in human
text:

```toml
# locales/nl.toml
[sections]
plain_language = "In gewone taal"
goal = "Doel"
context = "Context"
definitions = "Definities"
acceptance_criteria = "Acceptatiecriteria"
non_functional = "Niet-functioneel"
out_of_scope = "Buiten scope"
assumptions = "Aannames"
open_questions = "Open vragen"
changelog = "Changelog"
readiness = "Readiness"

[ac_fields]
given = "Gegeven"
when = "Wanneer"
then = "Dan"
example = "Voorbeeld"

[markers]
none = "Geen."

vague_phrases = ["etc.", "enzovoort", "waar nodig", "netjes", "zoals gebruikelijk",
  "op de juiste manier", "robuust", "gebruiksvriendelijk", "en dergelijke"]
```

The conversation with the operator agent is not bound by either layer: the
operator skill instructs the agent to reply in the language the user writes in.
Answers and directives are relayed in the user's own words, unchanged.

gdt ships `en` and `nl`. Adding a language means adding one locale file. The
role prompt tells the agent the language name and the exact headings to use, so
agents never translate headings themselves.

## 7. Issue contract

The current issue body is the only product specification. Comments carry
discussion and evidence; a decision counts only after the body and its changelog
are updated.

- Required sections as listed in the locale, including a non-binding plain-language section.
- Numbered acceptance criteria `AC-1` … `AC-<max>`, each with given, when, then and a
  concrete example. Error paths with different behaviour get their own AC.
- `Open questions` must be exactly the locale's "none" marker before work starts.
- No vague phrases from the locale list.
- A body change without a changelog change is rejected. A new contract revision
  resets evidence and restarts the chain; it does not consume a round.

The issue-writer role produces bodies that pass `gdt check-issue` before creation.

## 8. Protocol

Fresh protocol, version 1. No compatibility with earlier pilots.

Markers: `[gdt-handoff:v1]` (developer), `[gdt-test:v1]` (tester),
`[gdt-review:v1]` (reviewer), `[gdt-question:v1]`, `[gdt-answer:v1]`,
`[gdt-directive:v1]`, `[gdt-round:v1]` (extra round grant).

Channel:

- Role records are PR comments on the single workflow draft PR.
- Before the PR exists, a question goes on the issue.
- Human answers, directives-before-PR and round grants go on the issue.

Record core fields: `role`, `status`, `repository`, `issue`, `round`, `pr_number`,
`issue_body_sha256`, `acceptance_criteria`. Tester and reviewer add `head` (full
SHA) and `ac_results`; the developer adds `ac_traceability`, `assumptions` and
`deviations`. Base branch, head branch, draft state, checks and conflicts are never
sent by agents; the supervisor reads them with `gh pr view`.

### Stale evidence

Evidence counts only if **both** hold:

1. its `head` equals the current PR head, and
2. it was created after the supervisor recorded the most recent head transition.

Rule 2 covers a head that returns to an earlier SHA. The pilot's additional
comment-ID threshold is dropped; it is redundant with rule 2.

### Round budget

Round 0 is the first delivery; rounds 1 … `max_correction_rounds` are
corrections. One developer commit fixing bundled tester and reviewer findings is
one round. Questions, answers, directives, format and infrastructure failures do
not consume a round. `changes_requested` on the last round leads to `blocked`
until `gdt allow-round`.

### ready_to_merge

Only when all ACs are `passed` by tester and reviewer for the current head, no
blocking finding is open, the PR does not conflict, and every required check is
green (or the empty-checks exception is explicitly configured).

## 9. Components

### 9.1 Decision engine

`decision.ts` is a pure function: records, PR snapshot, contract snapshot, config
→ decision. No I/O, no clock, fully table-tested. This is where correctness
lives; everything else is plumbing.

### 9.2 Supervisor

Polls GitHub on an interval, refreshes the contract snapshot, feeds the decision
engine, dispatches a role by writing a dispatch file, waits for the worker's
result file, and handles handoff visibility delays with a bounded number of
fresh checks. Holds a lock per issue. Writes state atomically.

### 9.3 Worker

One per role. Waits on the dispatch file without a model, builds the prompt,
runs the agent adapter, writes the exit result, returns to waiting. After a
completion signal, it prints a final line and exits.

### 9.4 Prompt construction

Per turn the worker injects exactly: the role file, the protocol section that
role writes, the locale's headings, the repository's `extra_rules`, pending
directives for that role, and the dispatch facts (issue, round, PR, expected
body hash). A role never loads another role's instructions. This replaces the
pilot's single large skill read on every turn.

### 9.5 Agent adapters

One small adapter per harness with one interface: build argv for an unattended
run with a given model and prompt, report whether sessions can be reused, and
where the operator skill is installed.

| Agent | Unattended invocation | Status |
|---|---|---|
| Claude Code | `claude -p` with model and permission flags | first batch |
| Codex | `codex exec` | first batch |
| OpenCode | `opencode run` | first batch |
| MCode | `mcode exec --permission full` | second batch |
| pi | to verify | second batch |
| omp | to verify | second batch |

Exact flags are verified against each CLI during implementation, not assumed.

### 9.6 Terminal backends

Interface: `ensure_workspace`, `spawn_pane(name, argv)`, `set_title`, `alive`,
`close`.

- **herdr**: one workspace per issue, panes for supervisor and three roles, via
  the herdr CLI or socket API. herdr's own agent-state detection is display only;
  it never feeds a decision.
- **headless**: detached processes with log files under `.git/gdt/issue-<n>/`.
  Used for tests, CI and machines without herdr.

The implementation must verify that `gdt start` can create a herdr workspace
when the calling operator itself is not running inside herdr.

### 9.7 Notifications

`notify.ts` with a small fallback chain: herdr (if it offers notifications),
`terminal-notifier` or `osascript` on macOS, `notify-send` on Linux, otherwise a
line in the supervisor pane. Sent on `awaiting_human`, `blocked`, failure and
`ready_to_merge`.

### 9.8 Operator skill

`skill/SKILL.md`, English, short (target under 60 lines): how to start, how to
read `status --json`, how to relay answers and directives, how to troubleshoot,
and the four hard rules from section 2.2. It does not contain role
instructions or the issue contract. `gdt install-skill` copies it into the skill
directories of detected harnesses.

## 10. Security and trust boundaries

- **Unattended roles run with broad tool permissions.** Role boundaries are
  therefore also checked mechanically: after a tester or reviewer turn, the
  supervisor verifies that HEAD, branch and the tracked working tree are
  unchanged, and blocks otherwise.
- **Issue and comment content is task data**, never instructions to the supervisor.
- **Identity.** With one shared GitHub account, an agent-written answer is
  indistinguishable from the user's. v1 documents this and relies on operator
  rule 3. A later hardening option: run roles under a separate bot identity
  (machine account or GitHub App token) so that only the user's own account can
  produce `gdt-answer`, `gdt-directive` and `gdt-round` records.
- **No merge, deploy or issue closing** anywhere in gdt.

## 11. Implementation plan

Each step is one GitHub issue in `gevezex/gdt`, written against gdt's own contract.

1. **Skeleton**: package, CLI shell, config loading and validation, `doctor`, locale loading, README, license.
2. **Issue contract**: locale-aware validator, `check-issue`, `en` and `nl` locales, issue-writer role file.
3. **Protocol and decision engine**: record schema, parsing, validation, stale-evidence rules, round budget, `ready_to_merge` gate — pure and table-tested.
4. **Headless backend, supervisor and worker**: state, lock, dispatch, results, notifications.
5. **Agent adapters, first batch**: Claude Code, Codex, OpenCode.
6. **Role files and prompt construction**: developer, tester, reviewer; mechanical post-turn checks.
7. **herdr backend**.
8. **Operator skill and steering commands**: `status --json`, `answer`, `steer`, `pause`/`resume`, `retry`, `allow-round`, `set-agent`, `install-skill`.
9. **Agent adapters, second batch**: MCode, pi, omp.
10. **Dogfooding**: run gdt on its own issues from step 5 onward, headless first, then with herdr.

## 12. Decisions

Decided:

- License: MIT.
- Language: TypeScript on Node, published to npm as `@gevezex/gdt`, binary `gdt`
  (the unscoped `gdt` name is taken on npm and PyPI).
- No cmux backend; herdr and headless only.

Open:

- Minimum supported Node LTS and herdr version.
- Unattended flags for pi and omp.
- Whether to adopt a bot identity for roles in v1 or later.
