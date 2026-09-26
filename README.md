# gdt

**GitHub issues to merge-ready pull requests, with a developer, tester and reviewer agent.**

> Status: early development. Only `gdt doctor` exists; nothing is published to npm yet.
> See [docs/design.md](docs/design.md).

gdt runs one GitHub issue through three independent agent roles until a single
draft pull request is ready to merge, or until it needs your decision. A
deterministic supervisor decides whose turn it is, so waiting and polling cost
no model tokens. You drive it by talking to any coding agent — Claude Code,
Codex, OpenCode, MCode, pi or omp — and watch the roles work in
[herdr](https://herdr.dev).

```text
you ──► your agent: "pick up issue 251 with gdt"
          └─► gdt start 251 ──► herdr: supervisor │ developer │ tester │ reviewer
```

Principles:

- **The issue body is the contract.** Numbered acceptance criteria with given,
  when, then and a concrete example. Work starts only when there are no open questions.
- **Independent verification.** The tester derives its test matrix from the
  contract before reading the diff. Evidence is bound to the exact PR head.
- **Bounded cost.** A fixed correction-round budget; models run only on dispatched turns.
- **Fail closed.** When a trustworthy decision is impossible, gdt stops and tells you why.
- **Your language on GitHub.** Issues and PR text in your configured language;
  protocol and code in English.
- **Humans merge.** gdt never merges, deploys or closes issues.

Planned install:

```bash
npm i -g @gevezex/gdt
```

## Development

Requires Node 24 LTS.

```bash
npm ci
npm run build
npm run lint
npm test
node dist/cli.js doctor   # run inside a repository with .gdt/config.toml
```

## License

[MIT](LICENSE)
