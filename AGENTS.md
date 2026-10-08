# AGENTS.md — Phada

Instructions for people and coding agents working in this repository. User documentation is in
[README.md](README.md); the contribution workflow is in [CONTRIBUTING.md](CONTRIBUTING.md).

## What Phada is

A command-line tool that reviews a GitHub pull request with an AI provider the developer already
uses — an AI CLI they are logged into (Claude Code, Codex) or a model served by Ollama — prints
the review as Markdown or JSON and publishes it on the pull request as the owner of the GitHub
token. Phada is not the AI: it fetches the pull request, builds the prompt, runs the provider,
validates and scores the answer, formats the result and posts it.

## One engine, many callers

Keep **which AI reviews** (`ReviewProvider`) separate from **who runs the review** (the caller of
the engine, today `src/main.ts`). Code in `src/review/`:

- receives the pull request, the options and the provider as data and returns a result;
- never reads files, environment variables or `process.cwd()`, never prints, never talks to
  GitHub;
- never sees credentials.

`src/publish/` follows the same rules: it takes the earlier reviews and threads on the pull request
and the review result as data, decides whether to review and which findings to post, and never
talks to GitHub itself.

## Layout

```
src/
  bin.ts                 # entry point of the `phada` command: reads the package version, calls run()
  main.ts                # run(argv, deps): PR → review state → run/skip → review → publish; createProvider()
  architecture.test.ts   # allowed imports of src/review/ and src/publish/
  cli/                   # terminal edge
    args.ts              #   parseCliArgs(): `review` command (--dry-run, --force), --help, --version;
                         #   USAGE, REVIEW_USAGE
    errors.ts            #   UsageError, MissingGitHubTokenError
    format-review.ts     #   pull request summary (stderr) and the Markdown review (stdout)
    format-github.ts     #   the review as GitHub Markdown: body, line comments, markers, truncation;
                         #   formatGitHubPreview() for --dry-run
    format-publication.ts #  skip and "Published" messages
    format-json.ts       #   formatReviewJson(): schemaVersion 1, with the publication block
    markdown-text.ts     #   escapes AI text: block markers; for GitHub also HTML and mentions
    review-text.ts       #   model label and short SHA
    i18n/                #   fixed review text per language: messages.ts (Messages, messagesFor()),
                         #   en.ts, pt.ts; unknown languages fall back to English
    format-error.ts      #   error → one line + exit code (2 usage, 1 failure); --debug details
    progress.ts          #   withProgress(): ReviewProvider decorator with a live timer on a TTY
    terminal-text.ts     #   toTerminalText(): strips control and bidi characters from external text
    units.ts             #   duration, tokens, bytes, counts
  github/                # GitHub REST and GraphQL
    pull-request-ref.ts  #   parse/format "owner/repo#N" or a pull request URL
    errors.ts            #   GitHubError and typed errors
    request.ts           #   method, body, headers, timeout, status → error, token redaction
    json-fields.ts       #   typed reads of fields in GitHub answers
    graphql.ts           #   sendGraphQL(): errors in an HTTP 200 become GitHubGraphQLError
    pull-request.ts      #   fetchPullRequest()
    pull-request-reviews.ts # fetchReviewState(): viewer, reviews and threads, paginated
    create-review.ts     #   createReview(): one COMMENT review with line comments
  process/               # safe subprocess runner (stdin, timeout, typed errors)
    run-command.ts       #   runCommand(): returns the exit code, never interprets it
  providers/             # ReviewProvider and its implementations
    types.ts             #   ReviewProvider, ReviewPrompt, ReviewOutput, ProviderError
    cli-run.ts           #   shared by AI CLIs: temp dir, env without GitHub tokens, typed errors
    redact-secrets.ts    #   redacts token patterns from CLI output in error messages
    claude.ts            #   ClaudeCliProvider (+ claude-model.ts: model resolution)
    codex.ts             #   CodexCliProvider (+ codex-model.ts: model resolution)
    ollama.ts            #   OllamaProvider over HTTP (+ ollama-host.ts, node-http-fetch.ts)
  publish/               # pure: what to publish, data in, decision out
    markers.ts           #   the review and finding markers, read only at the end of a body
    phada-state.ts       #   Phada's own reviews and open threads (author = token owner + marker)
    decide-run.ts        #   decideRun(): review, or skip a commit Phada already reviewed
    plan-publication.ts  #   planPublication(): new comments vs findings still open in a thread
    types.ts             #   PublicationPlan, RunDecision, SkipReason
  review/                # the engine: data in, result out
    types.ts             #   ReviewRequest, Finding, ReviewResult, ReviewOutcome, …
    prompt-parts.ts      #   text shared by the review and verification prompts
    prompt.ts            #   buildReviewPrompt(): instructions + nonce-delimited data + output schema
    verify-prompt.ts     #   buildVerifyPrompt(): the second, skeptical pass (--verify)
    report-schema.ts     #   Zod schemas of the AI report + the JSON schema sent to providers
    verification-schema.ts # Zod schema of the verification verdicts
    diff-lines.ts        #   unified diff parsing and line numbering
    json-objects.ts      #   top-level JSON objects found in a text
    parse-report.ts      #   parseReviewReport()
    parse-verification.ts #  parseVerification()
    verify-findings.ts   #   verifyCandidates(), applyVerdicts()
    select-findings.ts   #   candidate filtering, confidence cut, worth checking, ordering
    score.ts             #   scoreFindings(): the 0–5 score, computed by Phada
    errors.ts            #   InvalidReviewReportError
    run-review.ts        #   runReview(): prompt → provider → parse → [verify] → select → score
scripts/smoke.ts         # packs the package, installs the tarball, runs the installed `phada`
test/fixtures/bin/       # fake AI CLIs used by the provider tests
test/fixtures/github/    # trimmed GitHub API responses (REST and GraphQL) and a synthetic diff
test/support/            # shared test helpers (fake fetch, fixtures for pull requests, findings, …)
```

Tests live next to the code they test (`*.test.ts`).

## Dependency rule

`src/review/` depends only on interfaces and types (`ReviewProvider`, `PullRequest`); its only
value imports from outside the folder are `node:crypto` and `zod`. It never imports a concrete
provider (`providers/claude.ts`, `providers/codex.ts`, `providers/ollama.ts`). Only `src/main.ts`
wires concrete implementations, and `src/bin.ts` passes it the real `process` streams and
environment. `src/publish/` imports only types from outside the folder (`src/review/types.ts`,
`src/github/pull-request-reviews.ts`). `src/architecture.test.ts` enforces the allowed imports of
both folders and forbids `process`/`console` inside them.

## Conventions

- TypeScript strict, ESM, Node >= 22. Relative imports use the `.js` extension
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
npm run smoke                          # pack, install and run the package
npm run dev -- review owner/repo#N     # needs GITHUB_TOKEN or GH_TOKEN
```

## Workflow

- One change per pull request, with Conventional Commits messages in English.
- Done means: format, typecheck, tests and smoke green (locally and in CI), no secrets, and the
  README updated when user-visible behavior changes.
