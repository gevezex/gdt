# Working rules for agents

These rules apply to every issue in this repository. The design lives in
[docs/design.md](docs/design.md); the issue body is the specification.

1. **Branch.** Create a feature branch from an up-to-date `main`
   (for example `issue-<n>-<slug>`). Never commit to `main` directly.
2. **Restate the ACs first.** Before writing code, restate the issue's
   acceptance criteria in your own words and note anything unclear. If the
   issue has open questions, stop and ask.
3. **Implement only the ACs.** Anything listed under "Out of scope", or not
   covered by an AC, stays out. Mention undecided choices in the PR body
   instead of guessing silently.
4. **One vitest test per AC at least.** Name tests after the AC
   (`describe("AC-3: ...")`). Tests must be hermetic: temporary repositories, a
   fake `PATH`, no network, no reliance on the machine's own `gh` login.
5. **Verify before finishing.** Run `npm run build`, `npm run lint` and
   `npm test`, and make sure all three pass.
6. **Draft pull request.** Open it as a draft against `main`. The body starts
   with `Closes #<n>` and contains a table mapping each AC to the files changed
   and the tests that cover it. Name and justify any new runtime dependency.
7. **Review fixes.** Address review comments on the same branch and update the
   existing pull request; do not open a second one.
8. **Merging.** Merge only under the bootstrap merge rule below. Never deploy or
   publish, and never close an issue by hand; `Closes #<n>` closes it on merge.
9. **Use `gh`** for all GitHub operations (issues, pull requests, checks).

Code conventions: TypeScript `strict`, ESM, Node 24 LTS. Runtime dependencies
stay minimal (currently `smol-toml` and `zod`).

## Bootstrap loop (issues #2 to #6)

Until gdt can run its own workflow (after #6), one agent session works through
issues #2 to #6 in order, one issue at a time, without a human relaying messages.

Per issue:

1. **Develop.** Follow rules 1 to 6 above. This is round 0.
2. **Review.** Start a reviewer with a fresh context that has not seen the
   development conversation (in Claude Code: a subagent; elsewhere a separate
   `claude -p` process). Give it only: the issue number, the PR number, the full
   head SHA and this file. The reviewer:
   - reads the issue body and `gh pr diff`, checks out the head in a separate
     worktree and runs build, lint and tests;
   - checks, in this order: each AC is met and covered by a test, nothing outside
     the ACs was added, undecided choices are named, then code quality;
   - changes no files and pushes nothing;
   - posts one PR comment starting with `## Review of <full head SHA>`, with the
     sections `Blocking` and `Non-blocking` (`None.` when empty).
3. **Fix.** Fix every blocking point on the same branch, then review again with a
   new fresh reviewer. Each fix commit after review is one correction round; at
   most 2 correction rounds per issue.
4. **Merge** when all of these hold:
   - CI is green on the exact head SHA;
   - the latest review is for that exact head SHA and has `Blocking: None.`;
   - the change stays within the issue's ACs.

   Then: `gh pr ready <pr>`, `gh pr merge <pr> --squash --delete-branch
   --match-head-commit <sha>`, update local `main`, delete the local branch and
   continue with the next issue.

**Stop and ask the user** instead of continuing when:

- an AC is ambiguous or two readings are possible, or an issue contradicts
  another issue or the design;
- a choice would change product behaviour that no AC settles;
- work is blocked (CI failing for reasons outside the change, missing tools or
  access);
- blocking review points remain after 2 correction rounds.

When stopping, post the question as a PR comment (or an issue comment before the
PR exists) and state it in the session. After #6 is merged, stop: from #7 on,
gdt runs its own issues.
