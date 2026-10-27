# AGENTS.md — Phada

Instructions for people and coding agents working in this repository. User documentation is in
[README.md](README.md); the contribution workflow is in [CONTRIBUTING.md](CONTRIBUTING.md).

## What Phada is

A command-line tool that reviews a GitHub pull request with an AI provider the developer already
uses — an AI CLI they are logged into (Claude Code, Codex) or a model served by Ollama — prints
the review as Markdown or JSON and publishes it on the pull request as the owner of the GitHub
token. Phada is not the AI: it fetches the pull request, builds the prompt, runs the provider,
validates and scores the answer, formats the result and posts it.
`phada` with no command, in a terminal, opens an app (`src/tui/`, Ink and React) that shows what
Phada has set up, running and reviewed, over the same use cases the commands use. `phada setup`
opens it on a step-by-step setup. The app writes only the user's own config (and the
`repos/<owner>/<repo>/` files it opens in the editor), and, when asked, the index and a
repository's `.phada/` (as `phada index` and `phada init` do).

## One engine, many callers

Keep **which AI reviews** (`ReviewProvider`) separate from **who runs the review** (the caller of
the engine, today `src/main.ts`). Code in `src/review/`:

- receives the pull request, the options and the provider as data and returns a result;
- never reads files, environment variables or `process.cwd()`, never prints, never talks to
  GitHub;
- never sees credentials.

The read use cases of `src/app/` (queue, history, rules, repositories, automation, provider,
learnings, home) return data, never text; the commands format it and the app draws it, so both
show the same facts.

`src/publish/` follows the same rules: it takes the earlier reviews and threads on the pull request
and the review result as data, decides whether to review and which findings to post, and never
talks to GitHub itself.

## Layout

One line per folder. [docs/layout.md](docs/layout.md) names every module and what it holds: read
it when looking for a module.

- `src/bin.ts` — entry point of the `phada` command: passes the real `process` streams,
  environment and signals to `run()`.
- `src/main.ts` — `run(argv, deps)`: the CLI flow and the wiring of the concrete implementations.
- `src/architecture.test.ts` — the dependency rule below, enforced.
- `src/app/` — use cases any caller runs (review and publish, watch, requests, indexing, the reads
  the commands and the terminal app share, the changes to the user config), with injected readers;
  reports through events.
- `src/cli/` — terminal edge: the commands, their wiring, and the review as text and JSON.
- `src/tui/` — the app `phada` opens in a terminal (Ink + React): data in, frames out.
- `src/config/` — the config files (`.phada/` in the repository and the user's own), the cache and
  data folders.
- `src/context/` — what the review sends besides the diff: rules, docs, CI, with injected readers.
- `src/skills/` — the skills installed for the AI CLIs.
- `src/github/` — GitHub REST and GraphQL.
- `src/gh-facade/` — the `gh` a native skill runs: reads answered by Phada, writes captured.
- `src/slack/` — Slack, and nothing else.
- `src/graph/` — the repository graph, resolved on demand from the index of a commit.
- `src/investigation/` — Phada's read-only tools the AI calls on the pull request head, and MCP.
- `src/process/` — the subprocess runners (output captured, or the terminal handed over) and the
  work folders.
- `src/providers/` — `ReviewProvider` and its implementations (Claude Code, Codex, Ollama).
- `src/publish/` — pure: what to publish, data in, decision out.
- `src/repository/` — the repository through git objects, in a persistent mirror.
- `src/repo-map/` — the code elements of a file, with tree-sitter (WASM).
- `src/store/` — SQLite: the index of each repository, the observed relations and the history.
- `src/watch/` — pure: what the watch does, data in, decision out.
- `src/review/` — the engine: data in, result out.
- `scripts/` — the build step for the grammars and the smoke test of the packed package.
- `test/` — fake AI CLIs, trimmed GitHub responses and shared helpers; each test sits next to the
  code it tests.

## Guides

- **Creating or changing a screen of the app:** read [src/tui/README.md](src/tui/README.md) first.
- **Reviewing a change:** [CODING_STANDARDS.md](CODING_STANDARDS.md) holds the judgment rules a
  review checks.

## Dependency rule

Only `src/main.ts` wires concrete implementations, and `src/bin.ts` passes it the real `process`
streams and environment. The limits of each folder:

- `src/review/` depends only on interfaces and types (`ReviewProvider`, `PullRequest`); its only
  value imports from outside the folder are `node:crypto` and `zod`. It never imports a concrete
  provider (`providers/claude.ts`, `providers/codex.ts`, `providers/ollama.ts`).
- `src/context/` reads nothing itself: `loadContext()` gets the readers of the repository and of the
  local disk as data, and its only value imports from outside the folder are `picomatch`,
  `node:path` and the pure config helpers (`parse-config.ts`, `merge-config.ts`); it takes the check
  runs, commit statuses and job logs of `src/github/` as types only.
- `src/publish/` imports only types from outside the folder (`src/review/types.ts`,
  `src/github/pull-request-reviews.ts`, `src/github/compare-commits.ts`), and the byte cut of
  `src/context/byte-cut.ts`.
- `src/watch/` imports only types from outside the folder (the watch settings, the listed and
  fetched pull requests, the issue comments and the CI summary) and never reads the clock: `now`
  comes in as data. Its records (`src/watch/types.ts`) are the watch's own; `src/store/` stores
  them.
- `src/store/` only talks to SQLite and never runs `git`; it stores the feedback records of
  `src/publish/feedback.ts` as types only.
- `src/repo-map/` parses text it is given (`web-tree-sitter`, reading only its grammars) and never
  runs `git`.
- `src/repository/` runs `git` through `src/process/run-command.ts`.
- `src/graph/` reads the index through an `IndexReader` and files through a function it is given;
  its only value imports from outside the folder are `node:path` and the pure diff parser
  (`src/review/diff-lines.ts`).
- `src/investigation/` reads the repository only through a `Checkout` (`src/repository/checkout.ts`)
  and a `RepositoryGraph` (`src/graph/types.ts`) the caller passes in, and never imports the mirror,
  the store, the CLI, the engine or a concrete provider. Its MCP client (`mcp/mcp-client.ts`) starts
  the declared servers with `node:child_process`, redacts what leaves it with
  `src/providers/redact-secrets.ts`, and gets their definitions (`src/config/mcp-servers.ts`, as a
  type) and the environment as data. The engine sees its tools only as a `Toolbox`
  (`src/investigation/toolbox.ts`) that the caller passes in.
- `src/app/` orchestrates a review from injected readers and factories and never imports the CLI, a
  concrete provider or the GitHub client, nor prints: it reports through events, and `main.ts` turns
  them into terminal output. `src/app/native-skill.ts` runs a native skill with the work tree, the
  gh facade and the work folders, and never sees the token.
- `src/skills/` reads the skills of the AI CLIs only through the `LocalFileSystem` it is given; its
  only value imports from outside the folder are `node:path` and `src/context/frontmatter.ts`.
- `src/slack/` only talks to Slack (`fetch` and `WebSocket`, both injectable) and imports nothing
  else; requests and replies are wired in `src/cli/slack-port.ts`, which only uses `submitRequest()`
  and the review events.
- `src/gh-facade/` never imports the GitHub client: reads go through the `ReadGitHub` function it is
  given, and writes are only captured.
- `src/tui/` draws the app with `ink` and `react` and imports, from outside the folder, only types
  of `src/app/` and `src/config/` and the pure helpers it names (`src/app/error-message.ts`,
  `src/app/terminal-text.ts`, `src/app/read-home.ts`, `src/app/home-recommendation.ts`,
  `src/app/read-provider.ts`); it never imports `src/github/`, a concrete provider or `src/cli/`,
  never touches `process` or `console` and never starts a timer: the streams, the signals, the
  environment and the scheduler come in through `openApp()`, which `src/cli/app-command.ts` loads
  with `import()` so the other commands never load React.
- `src/cli/review-wiring.ts` and `src/cli/watch-command.ts` declare the deps they need
  (`ReviewWiringDeps`, `WatchCommandDeps`); `MainDeps` extends them.

`src/architecture.test.ts` enforces the allowed imports of these folders and forbids
`process`/`console` inside them (`console` only, in `src/investigation/`). It also refuses a screen
of `src/tui/screens/` importing another screen, and a fixed pause (`setTimeout`, `setInterval`,
`settle()`, `sleep()`, `node:timers`) in the tests of `src/tui/`, which wait on a condition.

## Conventions

- TypeScript strict, ESM, Node >= 22.13. Relative imports use the `.js` extension
  (`import { x } from './y.js'`) because of `module: NodeNext`.
- Use `import type` for type-only imports (`verbatimModuleSyntax` is on).
- One responsibility per file; file names in `kebab-case`.
- Typed errors (classes extending `Error`) at boundaries: GitHub, subprocess, provider.
- External dependencies (`fetch`, command path, file reader) are injectable through an optional
  parameter with a real default, so tests never need module mocks.
- `npm test` never touches the network or a real AI CLI: use the fake `fetch` and fake binaries.
- Names carry the intent; no comments that restate the code.
- Never print, log or commit tokens. AI CLI authentication belongs to the CLI.
- Do not add folders, abstractions or dependencies before something uses them.

## Commands

```bash
npm run typecheck
npm test
npm run format
npm run lint:unused                    # unused files, exports and dependencies (Knip)
npm run smoke                          # pack, install and run the package
npm run dev -- review owner/repo#N     # needs GITHUB_TOKEN, GH_TOKEN or a gh login
npm run dev -- index owner/repo        # the repository map; PHADA_CACHE_HOME to keep it apart
npm run dev                            # the terminal app (in a terminal of at least 80×24)
```

## Workflow

- One change per pull request, with Conventional Commits messages in English.
- Done means: format, typecheck, tests, `lint:unused` and smoke green (locally and in CI), no
  secrets, and the README and the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) updated
  when user-visible behavior changes.
- A module added, moved or removed updates its entry in [docs/layout.md](docs/layout.md).
