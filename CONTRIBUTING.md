# Contributing to Phada

Thanks for helping. This guide covers running Phada from source, the checks a change must pass
and how to send it. [AGENTS.md](AGENTS.md) describes the code layout and the architecture rules.

## Run from source

You need Node.js 22 or newer and one AI provider set up as described in the
[README](README.md#requirements).

```bash
npm ci
export GITHUB_TOKEN=$(gh auth token)
npm run dev -- review owner/repo#123
```

`npm run dev` runs `src/bin.ts` with `tsx`, so there is no build step while you work.
`npm run -s review -- owner/repo#123` is a shortcut for the same command (`-s` keeps npm's own
banner out of stdout).

## Scripts

| Script                 | What it does                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `npm run dev`          | Runs the `phada` command from source, e.g. `npm run dev -- review owner/repo#123`          |
| `npm run review`       | Same as `npm run dev -- review`                                                            |
| `npm run typecheck`    | Type-checks the project with `tsc --noEmit`                                                |
| `npm test`             | Runs the test suite with Vitest                                                            |
| `npm run format`       | Formats the code with Prettier                                                             |
| `npm run format:check` | Checks formatting                                                                          |
| `npm run build`        | Compiles `src/` (without tests) to `dist/`                                                 |
| `npm run smoke`        | Packs the npm package, installs it in a temporary directory and runs the installed `phada` |

## Before you open a pull request

```bash
npm run format:check
npm run typecheck
npm test
npm run smoke
```

CI runs the same four commands.

## Tests

- `npm test` never touches the network or a real AI CLI. GitHub calls use a fake `fetch`
  (`test/support/fake-fetch.ts`) and the AI CLIs are replaced by fake binaries in
  `test/fixtures/bin/`.
- External dependencies (`fetch`, a command path, a file reader) are passed in through an
  optional parameter with a real default, so tests never need module mocks.
- Write the failing test first, then the code that makes it pass.

## Code conventions

- TypeScript `strict`, ESM, Node 22. Relative imports use the `.js` extension
  (`import { x } from './y.js'`), and type-only imports use `import type`.
- One responsibility per file; file names in `kebab-case`.
- Typed errors (classes extending `Error`) at the boundaries: GitHub, subprocess, provider.
- Names carry the intent; code has no comments that repeat what it does.
- No new dependency without a clear need: Phada keeps its runtime dependencies small.
- Never print, log or commit tokens.

## Commits and pull requests

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) in English
  and the imperative mood, on one line: `feat: add the --verify option`, `fix: …`, `docs: …`.
- One change per pull request. Describe what changes and why, how you tested it, and anything a
  reviewer should look at first.

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
