# Terminal backends

`workflow.terminal` selects how the supervisor and the three role workers are run. `headless` uses
detached processes with one log file per pane under `.git/gdt/issue-<n>/logs`. `herdr` runs them in
four panes of one herdr workspace named `gdt-<issue>` (design 9.6); pane titles are
`<role> · <agent> · <STATE>` and `supervisor · <status>`.

The minimum supported herdr version is **0.9.1**, the version the workspace, pane and title commands
this backend uses were verified against. `gdt doctor` reports an error when herdr is missing, cannot
report its version, or is older than that minimum.

# Agent adapters

Each role turn runs one agent CLI unattended. An adapter in `src/agents/` builds the command. It also
reports the model's vendor, which `gdt doctor` uses to warn when developer and tester share one. And it
names the user-level skill directory for the operator skill.

Placeholders below: `<model>` is `roles.<role>.model`, `<prompt-file>` is the per-turn prompt the
worker writes under `.git/gdt/issue-<n>/runs/`, and `<cwd>` is the repository root. The worker runs
the command in `<cwd>`. `< <prompt-file>` means the prompt is fed on stdin. The prompt is never
passed as a single argument, to stay within argument-length limits.

All three run with their permission prompts disabled, because nobody is there to answer them. The role
boundaries are enforced after each turn instead (design section 10). The agent's exit code is passed
through unchanged. The supervisor treats any non-zero code as a failed turn.

These invocations were checked against each CLI's `--help` output for the version named. Update the
version line when you re-verify against a newer CLI.

## Claude Code

Verified against: claude 2.1.283

```sh
claude -p --model <model> --permission-mode bypassPermissions --no-session-persistence < <prompt-file>
```

- Unattended: `-p` (print mode) runs one turn and exits.
- Model: `--model <model>`, for example `claude-sonnet-5`.
- Prompt: on stdin. With no prompt argument, `-p` reads the prompt from stdin.
- Permissions: `--permission-mode bypassPermissions` skips every permission prompt.
  `--no-session-persistence` keeps turns from piling up saved sessions (no session reuse).
- Vendor: `anthropic`.
- Skill directory: `~/.claude/skills/gdt`

## Codex

Verified against: codex-cli 0.157.1

```sh
codex exec --model <model> --cd <cwd> --dangerously-bypass-approvals-and-sandbox --ephemeral - < <prompt-file>
```

- Unattended: `codex exec` runs non-interactively.
- Model: `--model <model>`, for example `gpt-5.6-luna`.
- Prompt: on stdin. The prompt argument `-` makes `codex exec` read instructions from stdin.
- Permissions: `--dangerously-bypass-approvals-and-sandbox` skips approvals and the sandbox. Roles need
  network access for `gh` and `git push`, which the `workspace-write` sandbox blocks. `--cd <cwd>` sets
  the working root, and `--ephemeral` persists no session files.
- Vendor: `openai`.
- Skill directory: `~/.codex/skills/gdt`

## OpenCode

Verified against: opencode v2.0.18

```sh
opencode run --model <model> --auto --file <prompt-file> "Follow the instructions in the attached file."
```

- Unattended: `opencode run` sends one message and exits.
- Model: `--model <model>` in the form `provider/model`, for example `deepseek/deepseek-v4-flash`.
- Prompt: attached with `--file <prompt-file>`. The short message argument points to it.
  `opencode run` documents no stdin input, so the file attachment keeps the prompt out of argv.
- Permissions: `--auto` auto-approves every permission that is not explicitly denied.
- Vendor: the prefix before `/` in the model id, for example `deepseek`.
- Skill directory: `~/.config/opencode/skills/gdt`
