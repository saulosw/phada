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
                         #   src/graph/, src/app/, src/skills/, src/gh-facade/ and src/slack/
  app/                   # use cases any caller can run (CLI today), with injected readers
    review-pull-request.ts # reviewPullRequest(): repository context → mirror → index of the head
                         #   (60 s budget) → related repositories → graph and impact of the diff
                         #   across them → investigation → recheck of earlier comments → review →
                         #   observed relations → reports; progress through typed events;
                         #   loadPullRequestContext()
    review-and-publish.ts # reviewAndPublish(): fetch → decideRun → context → decideRun with the
                         #   diff fingerprint → threads to recheck (compare) → the conversation
                         #   (comments read unless conversation is off) → the checks of the head
                         #   (readCi, unless ci.read is off) → reviewPullRequest → plan → render
                         #   (injected, with the CI summary) → [checkHead] → reply and resolve
                         #   the fixed threads → createReview; never prints (the conversation
                         #   and the CI it read go out as events)
    watch-repositories.ts # watchRepositories(): the watch loop — discovery with ETags, planCycle
                         #   (asking the when command before queueing), /phada review comments,
                         #   the next job through the CI gate (readCi: waiting jobs read again
                         #   each minute, a failed read reviews at once) with its requests,
                         #   failures and pauses, requests moved
                         #   to a new commit, job events (notify), the idle index and feedback
                         #   refresh (30 min per pull request, 10 per cycle); events
    submit-request.ts    #   submitRequest(): a review request of any source → the policy (and the
                         #   when command) → a new job, a joined job or a refusal; whenInput()
    feedback.ts          #   recordReviewFeedback(): the threads a run read and the comments it
                         #   published → the history; refreshFeedback(): read due pull requests
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
    read-ci.ts           #   readCheckEntries(): check runs and statuses → the checks that count
                         #   (ci.checks: names or globs); readCi(): + the annotations and job logs
                         #   of the failing ones → buildCi(); each failure a warning (kept on
                         #   the Ci), a missing permission stops that kind of read
    inspect-context.ts   #   inspectPullRequestContext(), inspectRepositoryContext(): the context
                         #   without a review
    review-passes.ts     #   buildPasses(): review.prompt, review.skills or --skill → one SkillPass
                         #   per skill (paths matched here), SkillCatalog, PassPlan
    inspect-prompt.ts    #   inspectPrompt(), defaultPromptView(): the prompt of each pass and the
                         #   size of its data blocks (with the conversation and CI read), without
                         #   the AI
    read-conversation.ts #   readConversation(): the general comments (a failure is a warning) and
                         #   the review state → buildConversation()
    native-skill.ts      #   openNativeRunner(): work folder → work tree (with the conversation,
                         #   CI and impact files) → gh facade (with the checks as read) → the skill
                         #   run by the provider; skillPolicy(): commands and folders, read-only
                         #   for outside authors
    open-mcp.ts          #   openMcp(): declared MCP servers connected → their tools for the
                         #   investigation and a report per server; none for outside authors
  cli/                   # terminal edge
    args.ts              #   parseCliArgs(): `review` (--dry-run, --force, --verify/--no-verify,
                         #   --investigate/--no-investigate, --no-resolve, --no-conversation,
                         #   --no-ci, --skill), `init`, `index` (--ref, --format text|json), `rules`
                         #   (--format text|json), `prompt` (--default, --skill, --format
                         #   text|json), `watch` (--once,
                         #   --backfill, --status) and `history` (--since, --limit, --stats,
                         #   --refresh, prune --older-than), `enqueue` (--publish, --format) and
                         #   `mcp` commands, --help, --version; USAGE, REVIEW_USAGE, INIT_USAGE,
                         #   INDEX_USAGE, RULES_USAGE, PROMPT_USAGE, WATCH_USAGE, ENQUEUE_USAGE,
                         #   MCP_USAGE, HISTORY_USAGE
    init.ts              #   runInit(): .phada/ in the repository, or the user's own config
    init-templates.ts    #   the commented files phada init writes
    index-command.ts     #   runIndex(): token, cache folder, mirror, progress, the map's report
    rules-command.ts     #   runRules(): token, user config, the context of a pull request or of
                         #   the default branch, printed as text or JSON
    prompt-command.ts    #   runPrompt(): the built-in prompt, or the prompt of a pull request
                         #   with its conversation and checks (as the config turns them on)
    format-prompt.ts     #   formatPromptText(), formatPromptJson() (schemaVersion 1)
    skill-catalog.ts     #   diskSkillCatalog(): the installed skills, listed once, found by name;
                         #   claude:<name> for a skill built into Claude Code
    blocked-fix.ts       #   blockedFix(), blockedFixer(): the config line that allows a blocked
                         #   command or read
    read-dirs.ts         #   readDirResolver(): review.readDirs → existing folders (~ expanded)
    format-passes.ts     #   the "Skills:" line and the skills section of --dry-run
    watch-command.ts     #   runWatch(): settings, providers checked on start, history, lock, the
                         #   watch deps, one job's review; each job event sent to the sinks
    ci-gate-reader.ts    #   ciGateReader(): the ci settings of a job (user config and the root
                         #   .phada/config.yml at the base, read once per job) and the checks
                         #   that count of its head, for the CI gate; none with ci.read: false
                         #   or ci.wait: 0s
    enqueue-command.ts   #   runEnqueue(): a request from the command line
    mcp-command.ts       #   runMcp(): the queue tools as an MCP server over stdio
    queue-tools.ts       #   queueToolbox(): review_pull_request, job_status, wait_for_job, list_queue
    request-wiring.ts    #   submitDeps(): the pull request reader and the when command for requests;
                         #   requireWatchSettings(), watchSettingsOf(), RequestCommandDeps
    review-event-sinks.ts #  reviewEventSinkSettings(), openReviewEventSinks(): hooks and Slack as
                         #   destinations of the review events; the Slack tokens
    format-request.ts    #   refusalText(), formatSubmitText/Json(), jobJson()
    review-event.ts      #   reviewEvent(), storedEvent(), eventOfJob(): a job event → the event JSON
                         #   (schemaVersion 1) of hooks, Slack and wait_for_job, with the CI state
                         #   and the checks that count once the review read them
    run-shell.ts         #   runShell(), shellFailure(): a command of the user through sh, with its
                         #   own process group and a deadline
    run-hook.ts          #   runHook(): the hook of an event, its failure as a warning
    run-when.ts          #   whenChecker(): the when command, its refusal as a message
    queue-wake.ts        #   sleepUntilNewJob(): the watch's sleep, cut short by a new ready job
    slack-port.ts        #   slackPort(): Slack messages → requests; job events → reactions and
                         #   replies in the thread
    format-slack.ts      #   slackReplies(): the event as Slack text (link, summary, full), split
    watch-stop.ts        #   createStopControl(): Ctrl-C once (finish the review) or twice (abort);
                         #   trackRunningJob(): which job a second Ctrl-C puts back
    watch-events.ts      #   printWatchEvents(): the watch events as terminal lines
    watch-status.ts      #   watchStatusText(): --status in text or JSON
    history-command.ts   #   runHistory() (list, stats, --refresh), runHistoryPrune()
    format-history.ts    #   formatHistoryText/Json(), feedbackStats(), formatStatsText/Json()
                         #   (schemaVersion 1)
    format-watch.ts      #   formatWatchEvent(), formatWatchStatus(), formatWatchStatusJson(); a
                         #   job waiting for CI with its deadline and pending checks
    provider-choice.ts   #   assertProviderChoice(): known provider, model for ollama, no MCP
                         #   server names with ollama; providerRunsSkills()
    mcp-names.ts         #   checkMcpNames(): MCP server names checked with `claude mcp get` or
                         #   read with `codex mcp get --json` before the review
    classify-failure.ts  #   classifyFailure(): an error → transient, usage-limit, rate-limit,
                         #   definitive or fatal
    review-wiring.ts     #   pullRequestReviewDeps(), ciReaders(), renderReview, reviewRunJson():
                         #   shared by review, watch and prompt
    history-run.ts       #   historyRun(), watchRun(): a run or a failure → the history record
    format-rules.ts      #   formatRulesText(), formatRulesJson() (schemaVersion 1)
    context-sources.ts   #   contextSourcesAt(): the repository at a commit and the local files
    format-index.ts      #   formatIndexText(), formatIndexJson() (schemaVersion 1)
    suppress-sqlite-warning.ts # drops Node's ExperimentalWarning for the built-in SQLite
    errors.ts            #   UsageError, MissingGitHubTokenError, WatchRunningError
    format-review.ts     #   pull request summary (stderr) and the Markdown review (stdout)
    format-github.ts     #   the review as GitHub Markdown: body (the CI line under the score),
                         #   line comments, suggestion blocks, markers, truncation; formatResolvedReply(); formatGitHubPreview() for
                         #   --dry-run
    format-publication.ts #  skip, "Published", recheck and "Resolved" messages
    format-context.ts    #   the "Context:" line and the context section of --dry-run
    format-investigation.ts # the "Investigated:" line and the investigation section of --dry-run
    format-related.ts    #   the "Related:" line and the related repositories section of --dry-run
    format-impact.ts     #   the "Impact:" line and the impact section of --dry-run
    format-conversation.ts # the "Conversation:" line and the conversation section of --dry-run
                         #   (each item, what was left out over 16 KB and the bodies cut)
    format-ci.ts         #   the "CI:" line and the CI section of --dry-run (each check, the
                         #   annotations and logs left out, the cuts and the warnings)
    finding-references.ts #  the "Based on" line: sources (a CI check named as such), rule and skill
                         #   of a finding
    format-json.ts       #   formatReviewJson(): schemaVersion 1, with the publication, context,
                         #   conversation, ci, investigation, impact and recheck blocks
    markdown-text.ts     #   escapes AI text: block markers; for GitHub also HTML and mentions;
                         #   codeFence()
    review-text.ts       #   model label and short SHA
    i18n/                #   fixed review text per language: messages.ts (Messages, messagesFor()),
                         #   en.ts, pt.ts; unknown languages fall back to English
    format-error.ts      #   error → one line + exit code (2 usage, 1 failure); --debug details
    progress.ts          #   withProgress(): ReviewProvider decorator with a live timer on a TTY;
                         #   indexProgress(): the "Indexing N files…" lines
    terminal-text.ts     #   toTerminalText(): strips control and bidi characters from external text
    units.ts             #   duration, tokens, bytes, counts
  config/                # the config files: .phada/ in the repository and the user's own
    schema.ts            #   Zod schema of config.yml (ci: read, wait, checks); LANGUAGE_TAG
    parse-config.ts      #   parseConfigText(): YAML → config or an error naming the key
    merge-config.ts      #   mergeConfig(): layers → options, rules, files, ignore with origins (pure);
                         #   resolveProvider(): provider and model as a pair
    mcp-servers.ts       #   userMcp(), resolveMcp(): MCP server names and declared servers, with
                         #   ${VAR} expanded from the environment
    user-config.ts       #   the user's folder (PHADA_CONFIG_HOME › XDG › ~/.config/phada),
                         #   loadUserLayers(), loadTopLevelUserLayers()
    local-files.ts       #   LocalFileSystem and its node:fs implementation
    cache-paths.ts       #   the cache folder (PHADA_CACHE_HOME › XDG › ~/.cache/phada),
                         #   repositoryCache(): mirror, index and observed paths; pathSize()
    data-paths.ts        #   the data folder (PHADA_DATA_HOME › XDG › ~/.local/share/phada):
                         #   history.sqlite and watch.lock
    watch-settings.ts    #   resolveWatchSettings() with the defaults, historyEnabled()
    duration.ts          #   durationMs(): 90s, 5m, 1h, 30d
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
  skills/                # skills installed for the AI CLIs, read from disk through LocalFileSystem
    skill-locations.ts   #   skillRoots(): CLAUDE_CONFIG_DIR › ~/.claude, CODEX_HOME › ~/.codex,
                         #   ~/.agents
    installed-skills.ts  #   listInstalledSkills(): user skills and commands, plugin skills and
                         #   commands (installed_plugins.json, plugin.json), Codex and agents skills
    resolve-skill.ts     #   resolveSkill(): plugin:name, own skill › the only plugin, or SkillError
    skill-text.ts        #   readSkillText(): body without front matter + the .md files it names,
                         #   32 KB
    errors.ts            #   SkillError (exit code 2)
  github/                # GitHub REST and GraphQL
    pull-request-ref.ts  #   parse/format "owner/repo#N" or a pull request URL; splitRepoName()
    errors.ts            #   GitHubError and typed errors
    request.ts           #   method, body, headers, timeout, status → error, token redaction;
                         #   ensureReadable(): a 403 names the permission the token lacks
    json-fields.ts       #   typed reads of fields in GitHub answers
    graphql.ts           #   sendGraphQL(): errors in an HTTP 200 become GitHubGraphQLError
    pull-request.ts      #   fetchPullRequest(), fetchPullRequestMetadata(), fetchPullRequestHead()
    pull-request-reviews.ts # fetchReviewState(): viewer, pull request state, reviews (state, date,
                         #   author association, bot) and threads (id, outdated, first comment
                         #   with its URL and negative reactions, last 20 replies and the count),
                         #   paginated; fetchPullComments(): the general comments of the pull
                         #   request
    create-review.ts     #   createReview(): one COMMENT review with line comments (start_line for
                         #   several lines)
    compare-commits.ts   #   fetchComparison(): the files changed between two commits, with patches
    resolve-thread.ts    #   replyAndResolve(): resolve a review thread, then reply on it
    repository-files.ts  #   fetchRepositoryTree(), fetchRepositoryFile(): the repository at a commit
    repository.ts        #   fetchRepository(): visibility, default branch, empty; fetchBranchHead()
    list-pull-requests.ts #  listOpenPullRequests(): open pull requests, ETag of the first page
    issue-comments.ts    #   listIssueComments(): the comments of a repository since a time, ETag;
                         #   addCommentReaction()
    read-repository.ts   #   repositoryReader(): GET reads of one repository (and search/issues)
                         #   for the gh facade
    check-runs.ts        #   fetchCheckRuns(): the check runs of a commit with their times,
                         #   paginated; fetchCheckAnnotations(): the annotations of a check run
    commit-statuses.ts   #   fetchCommitStatuses(): the statuses of a commit (none when the
                         #   combined status counts zero)
    job-log.ts           #   fetchJobLog(): the end of an Actions job log, the redirect followed
                         #   without the token, the last 512 KB by Range, 10 MB at most
  gh-facade/             # the gh a native skill runs: answered by Phada, writes captured
    gh-command.ts        #   parseGhCommand(), filesToRead(): gh argv → command
    gh-jq.ts             #   applyJq(): --jq with paths only
    gh-answer.ts         #   answerGh(): reads from Phada's data or the repository reader, writes
                         #   captured, the rest refused
    gh-checks.ts         #   answerChecks(): gh pr checks from the checks Phada read, tab-separated
                         #   or --json (--jq), with gh's buckets and exit codes
    gh-server.ts         #   serveGhFacade(): socket server, bin/gh and bin/git, read limit per pass,
                         #   captures
    gh-bridge.ts         #   the executable bin/gh runs: argv, stdin and files in the checkout
                         #   → the socket
    git-guard.ts         #   gitRefusal(): git options a native skill may not use
    git-bridge.ts        #   the executable bin/git runs: refuse or exec the real git
    types.ts             #   GhPullData, GhCheck, GhCommand, ReadGitHub, GhFacadeError
  slack/                 # Slack, and nothing else: no queue, no review
    pull-links.ts        #   pullRequestLinks(): the pull request links of a message, 5 at most
    web-api.ts           #   slackWebApi(): replies in a thread, reactions, the Socket Mode URL
    socket-mode.ts       #   connectSocketMode(): acks, events, reconnection
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
      mcp-tools.ts       #     mcpTools(): the read-only (or listed) tools of connected MCP
                         #     servers as <server>__<tool>
      budget.ts          #     calls and bytes per review pass, answer size
      tool-log.ts        #     ToolLog: one record per tool call
      report.ts          #     buildInvestigationReport(): what the AI read, for the CLI and the JSON
    mcp/                 #   how the AI CLIs reach the tools, and how Phada reaches MCP servers
      mcp-client.ts      #     connectMcp(): an MCP client over stdio or streamable HTTP
      mcp-server.ts      #     the tools as a local MCP server (JSON-RPC over a socket)
      mcp-bridge.ts      #     what the AI CLI starts: stdio ↔ the socket of mcp-server.ts
  process/               # safe subprocess runner (stdin, timeout, typed errors)
    run-command.ts       #   runCommand(), runCommandBytes(): return the exit code, never interpret it;
                         #   detached children in their own process group, killDetachedChildren()
    work-dirs.ts         #   openWorkDir(), closeWorkDir(), removeOpenWorkDirs() (Ctrl-C),
                         #   sweepOrphanWorkDirs(): the phada-native-* folders
  providers/             # ReviewProvider and its implementations
    types.ts             #   ReviewProvider, ReviewPrompt, ReviewOutput, ProviderError
    cli-run.ts           #   shared by AI CLIs: temp dir, env without GitHub tokens, typed errors
    redact-secrets.ts    #   redacts token patterns from CLI output in error messages
    claude.ts            #   ClaudeCliProvider: review() and runSkill() (+ claude-model.ts: model
                         #   resolution; claude-skill-args.ts: allowed tools, temporary plugin)
    codex.ts             #   CodexCliProvider (+ codex-model.ts: model resolution; codex-mcp.ts:
                         #   named MCP servers as -c settings; mcp-env-launcher.ts: runs a server
                         #   with the env of a private file)
    ollama.ts            #   OllamaProvider over HTTP (+ ollama-host.ts, node-http-fetch.ts)
  publish/               # pure: what to publish, data in, decision out
    markers.ts           #   the review (with the diff fingerprint), finding and resolved markers,
                         #   read only at the end of a body; findingTitle()
    phada-state.ts       #   Phada's own reviews and open threads (author = token owner + marker);
                         #   resolvedByPhada(), reviewedShaOf()
    feedback.ts          #   threadFeedback(): each Phada thread → outcome (fixed, dismissed,
                         #   ignored, open) and marks (negative-reaction, human-reply);
                         #   findingFingerprint()
    decide-run.ts        #   decideRun(): review, or skip a commit Phada already reviewed or whose
                         #   filtered diff did not change (same-diff)
    recheck-candidates.ts #  threadsToRecheck(), withChanges(): Phada's open threads of older commits
                         #   and what changed in their files
    conversation.ts      #   buildConversation(): comments, reviews and threads → items oldest first
                         #   with the role of each author, without Phada's own (people's replies
                         #   to them kept), bodies cut at 2 KB, 16 KB in total (resolved ›
                         #   outdated › oldest left out first) and the report
    ci-state.ts          #   ciEntries(): check runs and commit statuses → the checks that count,
                         #   passing, failing or pending; ciSummary(): the CI state (none, pending,
                         #   passing, failing) and the names of the failing and pending checks
    ci-log.ts            #   failedStepLog(): an Actions job log → its failed step, without
                         #   timestamps or colors, the final 8 KB
    ci.ts                #   buildCi(): the checks for the AI (failing › pending › passing) with
                         #   title, summary, annotations (failure and warning, 50 in total) and
                         #   the failed step of the log (12 KB in total), the entries as read, the
                         #   summary and the report; ciLogsLeft()
    plan-publication.ts  #   planPublication(): new comments vs findings still open in a thread vs
                         #   findings whose thread a person resolved vs findings of a thread found
                         #   fixed in this run
    types.ts             #   PublicationPlan, RunDecision, SkipReason, Conversation(Report), Ci,
                         #   CiEntry, CiSummary, CiReport
  repository/            # the repository through git objects, in a persistent mirror
    checkout.ts          #   Checkout (read, grep, list, history), CheckoutError
    git-checkout.ts      #   GitCheckout: one commit of the mirror (log, blame); the git environment
                         #   without tokens
    git-mirror.ts        #   openGitMirror(): bare repository in the cache, fetch --depth 1 into
                         #   refs/phada/*, deepen to 200 commits for history, ls-tree -r,
                         #   cat-file --batch
    mirror-lock.ts       #   withMirrorLock(): one fetch at a time per mirror, stale locks taken over
    repo-path.ts         #   toRepoPath(): paths inside the repository only
    work-tree.ts         #   materializeWorkTree(): a checkout of the head with origin/<base> at
                         #   the merge base, objects shared with the mirror, the diff and the
                         #   files it is given next to it
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
                         #   repositories and pull requests, jobs and their review requests, runs
                         #   with their verdict, pause, runs(), prune()
    history-feedback.ts  #   published findings, observations and their signals (observed and
                         #   cleared), feedbackDue()
    history-columns.ts   #   the history tables (columns, keys) and their insert/upsert/update
    history-migrations.ts #  versioned migrations (PRAGMA user_version), a table rebuilt with the
                         #   foreign keys off; a newer file is refused
  watch/                 # pure: what the watch does, data in, decision out
    filters.ts           #   eligibility(): draft, bot, outside author, authors, labels, base
    plan-cycle.ts        #   planCycle(): baseline, seen, enqueue, supersede, gone
    next-job.ts          #   pickNext(): the next ready job, queued or waiting for CI, or until
                         #   when to wait (pause, limit); NOT_STARTED, notStarted()
    ci-gate.ts           #   ciGate(): CI state, ci.wait, onFailure, when Phada saw the commit and
                         #   now → review (with the checks still pending), wait (until, deadline)
                         #   or skip; 2 min for checks to appear, read again each minute
    failures.ts          #   afterFailure(): retries, pauses, failed, stop; rateLimitPause()
    request-policy.ts    #   decideRequest(): closed, outside author, join, already reviewed, ask the
                         #   when command, hourly limit; publishOf()
    pull-facts.ts        #   PullFacts of a listed or fetched pull request
    pr-commands.ts       #   prCommands(): /phada review comments → requests, and the cursor
    time.ts              #   later(): an ISO time plus a duration
    types.ts             #   JobRecord (ciDeadline, ciPending), RequestRecord, RequestSource,
                         #   PublishTarget, PullRecord, PauseState, JobStatus (waiting for CI),
                         #   FailureKind
  review/                # the engine: data in, result out
    types.ts             #   ReviewRequest, Finding, ReviewResult, ReviewOutcome, …
    prompt-parts.ts      #   text shared by the review and verification prompts: rules section,
                         #   docs block, conversation block and its rules, CI block and its rules
                         #   (a check cited as ci:<name>), related repositories
                         #   (RELATED, relatedBlocks()), impact block, diff scope and tools
    impact-text.ts       #   renderImpact(): the impact of the diff within its 4 KB budget
    prompt.ts            #   buildReviewPrompt(): instructions + nonce-delimited data + output schema;
                         #   reviewInstructionParts(): the reviewer lens (built-in, append, replace,
                         #   skill) and the fixed contract, with origins; reviewDataBlocks()
    nonce.ts             #   newNonce(): the random id of the data blocks
    verify-prompt.ts     #   buildVerifyPrompt(): the second, skeptical pass (--verify)
    report-schema.ts     #   Zod schemas of the AI report + the JSON schema sent to providers
    verification-schema.ts # Zod schema of the verification verdicts
    diff-lines.ts        #   unified diff parsing and line numbering; the text and @@ section of
                         #   each new-side line
    diff-fingerprint.ts  #   diffFingerprint(): paths and +/- lines of the filtered diff, hashed
    suggestions.ts       #   checkSuggestion(), checkSuggestions(): a code suggestion against the diff
    convert-prompt.ts    #   buildConvertPrompt(): a native skill's output → Phada's report
    native-context.ts    #   nativeSkillContext(): what a native skill is told about the checkout
                         #   and the files next to the diff; nativeSkillTexts(): the conversation
                         #   (conversation.jsonl), CI (ci.md) and impact with the related
                         #   repositories (impact.md) as the prompt blocks have them
    skill-output.ts      #   skillOutputText(), skillBodyText(): what a native skill wrote, 64 KB
    recheck-prompt.ts    #   buildRecheckPrompt(): earlier comments and what changed since them
    recheck-schema.ts    #   Zod schema of the recheck verdicts (fixed, still-valid, unsure)
    recheck-threads.ts   #   recheckThreads(): one call for the changed threads, verdicts per thread
    json-objects.ts      #   top-level JSON objects found in a text
    parse-report.ts      #   parseReviewReport()
    parse-verification.ts #  parseVerification()
    verify-findings.ts   #   verifyCandidates(), applyVerdicts()
    context-findings.ts  #   known rule and sources on each finding (ci:<name> of a failing check);
                         #   the severity a rule sets
    select-findings.ts   #   candidate filtering, confidence cut, worth checking, ordering
    score.ts             #   scoreFindings(): the 0–5 score, computed by Phada
    verdict.ts           #   reviewVerdict(): clean, comments or blocking, from the findings
    errors.ts            #   InvalidReviewReportError
    run-review.ts        #   runReview(): one pass per skill (prompt → provider → parse, or a
                         #   native run → conversion), merged → suggestions → [verify] → select →
                         #   score; skill bodies for native passes without findings in the diff
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
`src/github/pull-request-reviews.ts`, `src/github/compare-commits.ts` and the check runs,
commit statuses and job log of `src/github/`). `src/store/` stores the
feedback records of `src/publish/feedback.ts` as types only. `src/watch/` imports only types from outside the folder
(the watch settings, the listed and fetched pull requests, the issue comments and the CI summary) and never reads the clock: `now` comes in as
data. Its records (`src/watch/types.ts`) are the watch's own; `src/store/` stores them.
`src/cli/review-wiring.ts` and `src/cli/watch-command.ts` declare the deps they need
(`ReviewWiringDeps`, `WatchCommandDeps`); `MainDeps` extends them. `src/repository/` runs `git` through
`src/process/run-command.ts`. `src/investigation/` reads the repository only through a `Checkout`
(`src/repository/checkout.ts`) and a `RepositoryGraph` (`src/graph/types.ts`) the caller passes
in, and never imports the mirror, the store, the CLI, the engine or a concrete provider; its MCP
client (`mcp/mcp-client.ts`) starts the declared servers with `node:child_process`, redacts what
leaves it with `src/providers/redact-secrets.ts`, and gets their definitions
(`src/config/mcp-servers.ts`, as a type) and the environment as data; the
engine sees its tools only as a `Toolbox` (`src/investigation/toolbox.ts`) that the caller passes
in. `src/app/` orchestrates a review from injected readers and factories and never imports the
CLI, a concrete provider or the GitHub client, nor prints: it reports through events, and
`main.ts` turns them into terminal output.
`src/skills/` reads the skills of the AI CLIs only through the `LocalFileSystem` it is given; its
only value imports from outside the folder are `node:path` and `src/context/frontmatter.ts`.
`src/slack/` only talks to Slack (`fetch` and `WebSocket`, both injectable) and imports nothing
else; requests and replies are wired in `src/cli/slack-port.ts`, which only uses
`submitRequest()` and the review events. `src/gh-facade/` never imports the GitHub client: reads go through the `ReadGitHub` function it
is given, and writes are only captured. `src/app/native-skill.ts` runs a native skill with the
work tree, the gh facade and the work folders, and never sees the token.
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
