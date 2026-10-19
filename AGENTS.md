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
  bin.ts                 # entry point of the `phada` command: reads the package version, drops the
                         #   SQLite ExperimentalWarning (suppressSqliteWarning), calls run()
  main.ts                # run(argv, deps): CLI flow — flags, token, user config, provider choice,
                         #   then reviewAndPublish(), printing and saving the run in the history;
                         #   createProvider()
  architecture.test.ts   # allowed imports of src/review/, src/publish/, src/watch/, src/context/,
                         #   src/investigation/, src/repository/, src/repo-map/, src/store/,
                         #   src/graph/ and src/app/
  app/                   # use cases any caller can run (CLI today), with injected readers
    review-pull-request.ts # reviewPullRequest(): repository context → mirror → index of the head
                         #   (60 s budget) → related repositories → graph and impact of the diff
                         #   across them → investigation → review → observed relations → reports;
                         #   progress through typed events
    review-and-publish.ts # reviewAndPublish(): fetch → decideRun → reviewPullRequest → plan →
                         #   render (injected) → [checkHead] → createReview; never prints
    watch-repositories.ts # watchRepositories(): the watch loop — discovery with ETags, planCycle,
                         #   the next job, failures and pauses, the idle index refresh; events
    index-repository.ts  #   indexRepository(): mirror → files left out and why → indexCommit();
                         #   refreshIndex(): the same within a deadline (idle watch);
                         #   indexCommit(): extract new blobs (optional deadline) → store the commit
    related-repositories.ts # openRelatedRepositories(): metadata → selection → fetch of the default
                         #   branch → manifests and links → index of the linked ones (60 s in total)
    select-related.ts    #   selectCandidates() (access, empty, private on public, 20 at most),
                         #   rankRelated() (7: related to the change › linked › the rest)
    related-report.ts    #   rankOpened(), buildRelatedReport(), relatedSummaries(): the related
                         #   repositories for the prompt, the CLI and the JSON
    error-message.ts     #   errorMessage(): the message of any thrown value
    inspect-context.ts   #   inspectPullRequestContext(), inspectRepositoryContext(): the context
                         #   without a review
  cli/                   # terminal edge
    args.ts              #   parseCliArgs(): `review` (--dry-run, --force, --verify/--no-verify,
                         #   --investigate/--no-investigate), `init`, `index` (--ref, --format
                         #   text|json), `rules` (--format text|json) and `watch` (--once,
                         #   --backfill, --status) commands, --help, --version; USAGE,
                         #   REVIEW_USAGE, INIT_USAGE, INDEX_USAGE, RULES_USAGE, WATCH_USAGE
    init.ts              #   runInit(): .phada/ in the repository, or the user's own config
    init-templates.ts    #   the commented files phada init writes
    index-command.ts     #   runIndex(): token, cache folder, mirror, progress, the map's report
    rules-command.ts     #   runRules(): token, user config, the context of a pull request or of
                         #   the default branch, printed as text or JSON
    watch-command.ts     #   runWatch(): settings, providers checked on start, history, lock, the
                         #   watch deps, one job's review
    watch-stop.ts        #   createStopControl(): Ctrl-C once (finish the review) or twice (abort);
                         #   trackRunningJob(): which job a second Ctrl-C puts back
    watch-events.ts      #   printWatchEvents(): the watch events as terminal lines
    watch-status.ts      #   watchStatusText(): --status in text or JSON
    format-watch.ts      #   formatWatchEvent(), formatWatchStatus(), formatWatchStatusJson()
    provider-choice.ts   #   assertProviderChoice(): known provider, model for ollama, mcp only
                         #   with claude
    classify-failure.ts  #   classifyFailure(): an error → transient, usage-limit, rate-limit,
                         #   definitive or fatal
    review-wiring.ts     #   pullRequestReviewDeps(), renderReview, reviewRunJson(): shared by
                         #   review and watch
    history-run.ts       #   historyRun(), watchRun(): a run or a failure → the history record
    format-rules.ts      #   formatRulesText(), formatRulesJson() (schemaVersion 1)
    context-sources.ts   #   contextSourcesAt(): the repository at a commit and the local files
    format-index.ts      #   formatIndexText(), formatIndexJson() (schemaVersion 1)
    suppress-sqlite-warning.ts # drops Node's ExperimentalWarning for the built-in SQLite
    errors.ts            #   UsageError, MissingGitHubTokenError, WatchRunningError
    format-review.ts     #   pull request summary (stderr) and the Markdown review (stdout)
    format-github.ts     #   the review as GitHub Markdown: body, line comments, markers, truncation;
                         #   formatGitHubPreview() for --dry-run
    format-publication.ts #  skip and "Published" messages
    format-context.ts    #   the "Context:" line and the context section of --dry-run
    format-investigation.ts # the "Investigated:" line and the investigation section of --dry-run
    format-related.ts    #   the "Related:" line and the related repositories section of --dry-run
    format-impact.ts     #   the "Impact:" line and the impact section of --dry-run
    finding-references.ts #  the "Based on" line: sources and rule of a finding
    format-json.ts       #   formatReviewJson(): schemaVersion 1, with the publication, context,
                         #   investigation and impact blocks
    markdown-text.ts     #   escapes AI text: block markers; for GitHub also HTML and mentions
    review-text.ts       #   model label and short SHA
    i18n/                #   fixed review text per language: messages.ts (Messages, messagesFor()),
                         #   en.ts, pt.ts; unknown languages fall back to English
    format-error.ts      #   error → one line + exit code (2 usage, 1 failure); --debug details
    progress.ts          #   withProgress(): ReviewProvider decorator with a live timer on a TTY;
                         #   indexProgress(): the "Indexing N files…" lines
    terminal-text.ts     #   toTerminalText(): strips control and bidi characters from external text
    units.ts             #   duration, tokens, bytes, counts
  config/                # the config files: .phada/ in the repository and the user's own
    schema.ts            #   Zod schema of config.yml; LANGUAGE_TAG
    parse-config.ts      #   parseConfigText(): YAML → config or an error naming the key
    merge-config.ts      #   mergeConfig(): layers → options, rules, files, ignore with origins (pure);
                         #   resolveProvider(): provider and model as a pair
    user-config.ts       #   the user's folder (PHADA_CONFIG_HOME › XDG › ~/.config/phada),
                         #   loadUserLayers(), loadTopLevelUserLayers()
    local-files.ts       #   LocalFileSystem and its node:fs implementation
    cache-paths.ts       #   the cache folder (PHADA_CACHE_HOME › XDG › ~/.cache/phada),
                         #   repositoryCache(): mirror, index and observed paths; pathSize()
    data-paths.ts        #   the data folder (PHADA_DATA_HOME › XDG › ~/.local/share/phada):
                         #   history.sqlite and watch.lock
    watch-settings.ts    #   resolveWatchSettings() with the defaults, historyEnabled()
    duration.ts          #   durationMs(): 90s, 5m, 1h
    errors.ts            #   ConfigError
  context/               # what the review sends besides the diff, with injected readers
    phada-paths.ts       #   .phada/ folders from the root to each changed file
    split-diff.ts        #   a unified diff split by file
    ignore.ts            #   DEFAULT_IGNORE (lockfiles, minified files, source maps), applyIgnore()
    select-docs.ts       #   docs by priority (including other tools' instruction files), the
                         #   60 KB budget, cutting a doc at 20 KB
    frontmatter.ts       #   readFrontmatter(): the front matter of an instruction file, line by line
    doc-scope.ts         #   docScope(): always, globs, manual or excluded, from applyTo, globs,
                         #   alwaysApply, description and excludeAgent
    load-context.ts      #   loadContext(): config files, rules in scope, ignore, docs in scope →
                         #   ReviewContext + report
    list-context.ts      #   listContext(): every .phada/ folder, rule and candidate doc of a branch
    types.ts             #   ContextReport, ContextSources, LoadedContext
  github/                # GitHub REST and GraphQL
    pull-request-ref.ts  #   parse/format "owner/repo#N" or a pull request URL; splitRepoName()
    errors.ts            #   GitHubError and typed errors
    request.ts           #   method, body, headers, timeout, status → error, token redaction
    json-fields.ts       #   typed reads of fields in GitHub answers
    graphql.ts           #   sendGraphQL(): errors in an HTTP 200 become GitHubGraphQLError
    pull-request.ts      #   fetchPullRequest(), fetchPullRequestHead()
    pull-request-reviews.ts # fetchReviewState(): viewer, reviews and threads, paginated
    create-review.ts     #   createReview(): one COMMENT review with line comments
    repository-files.ts  #   fetchRepositoryTree(), fetchRepositoryFile(): the repository at a commit
    repository.ts        #   fetchRepository(): visibility, default branch, empty; fetchBranchHead()
    list-pull-requests.ts #  listOpenPullRequests(): open pull requests, ETag of the first page
  graph/                 # the repository graph, resolved on demand from the index of a commit
    types.ts             #   RepositoryGraph, GraphSymbol, Site, Dependency, …
    project-config.ts    #   tsconfig/jsconfig paths, package.json of the repository's own
                         #   packages, go.mod modules, Python roots
    resolve-module.ts    #   import specifier → files of the commit, or external;
                         #   resolvePackage(): a package of the repository as seen from outside
    resolve-name.ts      #   NameResolver: call or use → definitions (resolved, inferred, external)
    repository-graph.ts  #   openRepositoryGraph(): findSymbol, callers, dependencies, similar,
                         #   symbolAt, lineText, observed relations, exported, externalSites
    packages.ts          #   readPackages(): what the manifests publish and depend on (npm, Go,
                         #   Python)
    toml.ts              #   parseTomlTables(): the strings and string arrays of each TOML table
    repository-links.ts  #   linkRepositories(): packages one repository publishes and the other uses
    linked-graph.ts      #   linkGraphs(): callers in consumers, dependencies in publishers
    similar.ts           #   scoreSimilar(): calls, parameters, name tokens, owner kind
    impact.ts            #   changedLines(), computeImpact(): changed symbols → callers and dependencies
    observe.ts           #   learnObservedEdges(): confirmed finding + source the AI read → relation
    report.ts            #   buildImpactReport(): the impact for the CLI and the JSON
  investigation/         # the AI reads the pull request head with Phada's read-only tools
    toolbox.ts           #   the tools contract: ToolDefinition, ToolResult, Toolbox
    create-investigation.ts # createInvestigation(): checkout (+ graph) → tools per pass + log
    tools/               #   the tools, pure over a Checkout and a RepositoryGraph
      tool-registry.ts   #     RegisteredTool, createToolbox(): validation, budget, answer size, log
      repository-tools.ts #    read_file, grep and list
      related-repo.ts    #     the repo argument of the tools; owner/repo:path
      history-tool.ts    #     history: commits and blame of a file, pull request from the subject
      graph-tools.ts     #     find_symbol, callers, dependencies and similar
      budget.ts          #     calls and bytes per review pass, answer size
      tool-log.ts        #     ToolLog: one record per tool call
      report.ts          #     buildInvestigationReport(): what the AI read, for the CLI and the JSON
    mcp/                 #   how the AI CLIs reach the tools
      mcp-server.ts      #     the tools as a local MCP server (JSON-RPC over a socket)
      mcp-bridge.ts      #     what the AI CLI starts: stdio ↔ the socket of mcp-server.ts
  process/               # safe subprocess runner (stdin, timeout, typed errors)
    run-command.ts       #   runCommand(), runCommandBytes(): return the exit code, never interpret it;
                         #   detached children in their own process group, killDetachedChildren()
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
    plan-publication.ts  #   planPublication(): new comments vs findings still open in a thread vs
                         #   findings whose thread someone resolved
    types.ts             #   PublicationPlan, RunDecision, SkipReason
  repository/            # the repository through git objects, in a persistent mirror
    checkout.ts          #   Checkout (read, grep, list, history), CheckoutError
    git-checkout.ts      #   GitCheckout: one commit of the mirror (log, blame); the git environment
                         #   without tokens
    git-mirror.ts        #   openGitMirror(): bare repository in the cache, fetch --depth 1 into
                         #   refs/phada/*, deepen to 200 commits for history, ls-tree -r,
                         #   cat-file --batch
    mirror-lock.ts       #   withMirrorLock(): one fetch at a time per mirror, stale locks taken over
    repo-path.ts         #   toRepoPath(): paths inside the repository only
  repo-map/              # the code elements of a file, with tree-sitter (WASM)
    languages.ts         #   languageOf(): extension → TypeScript, TSX, JavaScript, Python, Go
    grammars.ts          #   readGrammar(): dist/grammars/ in the package, node_modules in development
    extract.ts           #   createExtractor(): parse with a timeout → FileMap or 'timeout'
    walk.ts              #   Collector: symbols with their owner, imports, exports, calls, heritage,
                         #   uses of imported names
    languages/           #   one walker per language: javascript-like.ts, python.ts, go.ts
    types.ts             #   FileMap, ExtractedSymbol, SymbolKind, …
  store/                 # the map in SQLite (node:sqlite), one file per repository
    schema.ts            #   tables and SCHEMA_VERSION (another version is rebuilt)
    index-store.ts       #   openIndexStore(): blobs, commits, summary, prune, reader()
    index-reader.ts      #   IndexReader: the files, symbols, calls and uses of one commit
    observed-store.ts    #   openObservedStore(): relations learned from reviews (own schema)
    history-store.ts     #   openHistoryStore(): the review history, never rebuilt; watched
                         #   repositories and pull requests, jobs, runs, pause
    history-columns.ts   #   the history tables (columns, keys) and their insert/upsert/update
    history-migrations.ts #  versioned migrations (PRAGMA user_version); a newer file is refused
  watch/                 # pure: what the watch does, data in, decision out
    filters.ts           #   eligibility(): draft, bot, outside author, authors, labels, base
    plan-cycle.ts        #   planCycle(): baseline, seen, enqueue, supersede, gone
    next-job.ts          #   pickNext(): the next ready job, or until when to wait (pause, limit)
    failures.ts          #   afterFailure(): retries, pauses, failed, stop; rateLimitPause()
    time.ts              #   later(): an ISO time plus a duration
    types.ts             #   JobRecord, PullRecord, PauseState, JobStatus, FailureKind
  review/                # the engine: data in, result out
    types.ts             #   ReviewRequest, Finding, ReviewResult, ReviewOutcome, …
    prompt-parts.ts      #   text shared by the review and verification prompts: rules section,
                         #   docs block, related repositories (RELATED, relatedBlocks()), impact
                         #   block, diff scope and tools
    impact-text.ts       #   renderImpact(): the impact of the diff within its 4 KB budget
    prompt.ts            #   buildReviewPrompt(): instructions + nonce-delimited data + output schema
    verify-prompt.ts     #   buildVerifyPrompt(): the second, skeptical pass (--verify)
    report-schema.ts     #   Zod schemas of the AI report + the JSON schema sent to providers
    verification-schema.ts # Zod schema of the verification verdicts
    diff-lines.ts        #   unified diff parsing and line numbering
    json-objects.ts      #   top-level JSON objects found in a text
    parse-report.ts      #   parseReviewReport()
    parse-verification.ts #  parseVerification()
    verify-findings.ts   #   verifyCandidates(), applyVerdicts()
    context-findings.ts  #   known rule and sources on each finding; the severity a rule sets
    select-findings.ts   #   candidate filtering, confidence cut, worth checking, ordering
    score.ts             #   scoreFindings(): the 0–5 score, computed by Phada
    errors.ts            #   InvalidReviewReportError
    run-review.ts        #   runReview(): prompt → provider → parse → [verify] → select → score
scripts/smoke.ts         # packs the package, installs the tarball, runs the installed `phada`
scripts/copy-grammars.ts # build step: the tree-sitter grammars into dist/grammars/
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
environment. `src/context/` reads nothing itself: `loadContext()` gets the readers of the
repository and of the local disk as data, and its only value imports from outside the folder are
`picomatch`, `node:path` and the pure config helpers (`parse-config.ts`, `merge-config.ts`).
`src/publish/` imports only types from outside the folder (`src/review/types.ts`,
`src/github/pull-request-reviews.ts`). `src/watch/` imports only types from outside the folder
(the watch settings and the listed pull requests) and never reads the clock: `now` comes in as
data. Its records (`src/watch/types.ts`) are the watch's own; `src/store/` stores them.
`src/cli/review-wiring.ts` and `src/cli/watch-command.ts` declare the deps they need
(`ReviewWiringDeps`, `WatchCommandDeps`); `MainDeps` extends them. `src/repository/` runs `git` through
`src/process/run-command.ts`. `src/investigation/` reads the repository only through a `Checkout`
(`src/repository/checkout.ts`) and a `RepositoryGraph` (`src/graph/types.ts`) the caller passes
in, and never imports the mirror, the store, the CLI, the engine or a concrete provider; the
engine sees its tools only as a `Toolbox` (`src/investigation/toolbox.ts`) that the caller passes
in. `src/app/` orchestrates a review from injected readers and factories and never imports the
CLI, a concrete provider or the GitHub client, nor prints: it reports through events, and
`main.ts` turns them into terminal output.
`src/architecture.test.ts` enforces the allowed imports of these folders and forbids
`process`/`console` inside them (`console` only, in `src/investigation/`). `src/repo-map/` parses
text it is given (`web-tree-sitter`, reading only its grammars) and `src/store/` only talks to
SQLite; neither runs `git`. `src/graph/` reads the index through an `IndexReader` and files
through a function it is given; its only value imports from outside the folder are `node:path`
and the pure diff parser (`src/review/diff-lines.ts`).

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
npm run smoke                          # pack, install and run the package
npm run dev -- review owner/repo#N     # needs GITHUB_TOKEN or GH_TOKEN
npm run dev -- index owner/repo        # the repository map; PHADA_CACHE_HOME to keep it apart
```

## Workflow

- One change per pull request, with Conventional Commits messages in English.
- Done means: format, typecheck, tests and smoke green (locally and in CI), no secrets, and the
  README and the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) updated when user-visible
  behavior changes.
