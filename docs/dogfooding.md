# Dogfooding

gdt is run on this repository's own issues before it is recommended to others.
This page records every real run, so the evidence is available next to the
implementation plan (`docs/design.md`, section 11, step 10).

A dogfood run goes from `gdt start <issue>` to `ready_to_merge` or `blocked`
(exactly the two terminal outcomes of `docs/design.md`, section 9). The backend
is the `workflow.terminal` in effect for that run: `headless` or `herdr`
(`docs/design.md`, section 9.6).

| Issue | Date | Backend | Agents (developer / tester / reviewer) | Rounds | Final status | Human interventions | Problems found |
|---|---|---|---|---|---|---|---|
| #8 | 2026-09-26 | headless | opencode / claude / codex | 0 | ready_to_merge | none | none |
| #7 | 2026-09-26 | headless | opencode / claude / codex | 0 | blocked | operator fixed a flaky required check in the pull request and re-ran the review by hand | the reviewer's block could not be lifted after the fix, so the run was finished by hand (#21) |
| #21 | 2026-09-26 | herdr | opencode / claude / codex | 0 | ready_to_merge | none | none |
| #9 | 2026-09-27 | herdr | opencode / claude / codex | 0 | ready_to_merge | answered question Q1 (unattended mode for MCode, pi and omp) | none |

## Reading a record

- **Issue** is the open issue the run was started on; its pull request carries the
  `[gdt-handoff:v1]`, `[gdt-test:v1]` and `[gdt-review:v1]` records: #19 (run #8),
  #20 (run #7), #22 (run #21) and #23 (run #9).
- **Rounds** counts correction rounds after round 0 (the developer's first
  delivery). All runs so far needed none.
- **Human interventions** is anything a person did that the loop could not do
  itself. Merging is a human action by design and is not counted here.
- **Problems found** lists problems the run surfaced; each one links to the
  GitHub issue it became, or is `none`.

Run #10 (this issue) was still in progress when this page was written, so the
table lists completed runs only.
