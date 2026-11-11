# Contributing to Phada

Thanks for helping. [AGENTS.md](AGENTS.md) holds the architecture rules and
[docs/layout.md](docs/layout.md) the code layout.

## Run from source

You need Node.js 22.13 or newer and one AI provider (see
[Requirements of each provider](docs/providers.md#requirements-of-each-provider)).

```bash
npm ci
export GITHUB_TOKEN=$(gh auth token)
npm run dev -- review owner/repo#123
```

`npm run dev` runs `src/bin.ts` with `tsx`: no build step while you work.

| Script                 | What it does                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `npm run dev`          | Runs the `phada` command from source, e.g. `npm run dev -- review owner/repo#123`          |
| `npm run review`       | Same as `npm run dev -- review`; `npm run -s review` keeps npm's banner out of stdout      |
| `npm run typecheck`    | Type-checks the project with `tsc --noEmit`                                                |
| `npm test`             | Runs the test suite with Vitest                                                            |
| `npm run format`       | Formats the code with Prettier                                                             |
| `npm run format:check` | Checks formatting                                                                          |
| `npm run lint:unused`  | Finds unused files, exports and dependencies with Knip                                     |
| `npm run build`        | Compiles `src/` (without tests) to `dist/`                                                 |
| `npm run smoke`        | Packs the npm package, installs it in a temporary directory and runs the installed `phada` |
| `npm run demo`         | Makes the GIFs and the image of the README again, in Docker (see `docs/demo/README.md`)    |

## Before you open a pull request

CI runs these five commands; run them first:

```bash
npm run format:check
npm run typecheck
npm run lint:unused
npm test
npm run smoke
```

`npm ci` turns on the Git hooks in `.githooks/` (`git config core.hooksPath .githooks`). The
`pre-push` hook runs `format:check`, `typecheck`, the tests and `lint:unused` and stops the push
when one fails. `git push --no-verify` skips it in an emergency; CI still runs the checks.

## Tests and code

- `npm test` never touches the network or a real AI CLI: GitHub calls use a fake `fetch`
  (`test/support/fake-fetch.ts`) and the AI CLIs are fake binaries in `test/fixtures/bin/`.
- External dependencies (`fetch`, a command path, a file reader) come in through an optional
  parameter with a real default, so tests never need module mocks.
- Write the failing test first, then the code that makes it pass.
- TypeScript `strict`, ESM, Node 22.13. Relative imports use the `.js` extension
  (`import { x } from './y.js'`); type-only imports use `import type`.
- One responsibility per file; file names in `kebab-case`.
- Typed errors (classes extending `Error`) at the boundaries: GitHub, subprocess, provider.
- Names carry the intent; no comments that repeat what the code does.
- No new dependency without a clear need: the runtime dependencies stay small.
- Never print, log or commit tokens.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/) in English, imperative, one line:
  `feat: add the --verify option`, `fix: …`, `docs: …`.
- One change per pull request: what changes and why, how you tested it, and what a reviewer should
  look at first.
- A change users notice (a new option, different output, a fixed bug) adds a line to the
  `Unreleased` section of [CHANGELOG.md](CHANGELOG.md), and updates the [README](README.md) or the
  page of `docs/` that covers it when it changes how Phada is used.

## Releases

A maintainer bumps `version` in `package.json`, moves the `Unreleased` notes under the new version
and pushes the tag `vX.Y.Z`. The release workflow checks the tag against the version, runs the
checks and puts the package in the npm stage, unpublished. A maintainer reviews it
(`npm stage list`, `npm stage view phada@X.Y.Z`) and approves it with two-factor authentication
(`npm stage approve <id>`, or on the npm website); only then does the version go live.

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
