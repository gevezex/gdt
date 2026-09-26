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
8. **Never merge.** Humans merge, deploy and close issues.
9. **Use `gh`** for all GitHub operations (issues, pull requests, checks).

Code conventions: TypeScript `strict`, ESM, Node 24 LTS. Runtime dependencies
stay minimal (currently `smol-toml` and `zod`).
