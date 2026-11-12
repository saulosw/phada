# Layout

Every module of Phada and what it holds, one line each, grouped by folder. Read it when looking for
a module. How the folders fit together is in [architecture.md](architecture.md); the rules between
them are in [AGENTS.md](../AGENTS.md#dependency-rule). A module added, moved or removed updates its
line here.

Tests sit next to the module they test (`*.test.ts`, and `*.test.tsx` for the frames of the app)
and are not listed. `src/architecture.test.ts` enforces the dependency rule.

## `src/`

The entry point and the command flow.

- `bin.ts` — entry point of `phada`: the package version, the real `process`, the GitHub functions,
  the file system, the stores and the signals passed to `run()`.
- `main.ts` — `run(argv, deps)`: the arguments parsed, each command handed to its module of
  `src/cli/`, an error turned into a message and an exit code; `createProvider()`.

## `src/app/`

Use cases any caller runs, with injected readers and factories; they report through events and
never print.

- `apply-file-suggestions.ts` — `applyFileSuggestions()`: the code suggestions of numbered findings
  applied file by file.
- `check-providers.ts` — `checkProviders()`: Claude Code, Codex and Ollama checked at once, the
  chosen one marked.
- `ci-at.ts` — `ciReadersAt()`: CI readers that read checks finished after a moment as still
  running.
- `code-elements.ts` — `codeElements()`: the code elements of a file at a commit, cached.
- `decide-lesson.ts` — `acceptLesson()`, `discardLesson()`: a pending lesson written as a rule of
  the user config, or dropped.
- `edit-user-config.ts` — `planUserConfig()`, `applyUserConfigPlan()`: a change to the user's
  `config.yml`, planned, then written atomically.
- `error-message.ts` — `errorMessage()`: the message of any thrown value.
- `explore-graph.ts` — `openGraphExplorer()`: the graph of a repository linked to its indexed
  related repositories, for symbol search.
- `feedback.ts` — `recordReviewFeedback()`, `refreshFeedback()`: what happened to Phada's comments,
  kept in the history.
- `fix-findings.ts` — `fixFindings()`: suggestions applied, then the rest of the findings sent to
  the provider's `fix()`.
- `harvest-misses.ts` — `harvestMisses()`: the threads read and the local runs turned into misses;
  `reportedFindings()`.
- `home-recommendation.ts` — `recommend()`: the one next step the Home screen shows.
- `index-repository.ts` — `indexRepository()`, `refreshIndex()`: the map of a repository's code
  built from the mirror.
- `inspect-prompt.ts` — `inspectPrompt()`: the prompt of each pass and the size of its blocks,
  without the AI.
- `lesson-answers.ts` — `checkLessonAnswers()`: the lessons the AI proposed, checked against what
  it was sent.
- `lesson-rule.ts` — `lessonRuleId()`, `lessonThreads()`: pure, also drawn by the app.
- `local-fix.ts` — `readLocalFix()`: the findings of the last local review of the branch, numbered.
- `local-pull-request.ts` — `localPullRequest()`: the pull request a local review assembles.
- `local-repository.ts` — `openLocalRepository()`: a repository's read-only index and mirror files
  at a commit.
- `local-review.ts` — `reviewLocalChanges()`: the local branch, or the working tree, reviewed as a
  pull request.
- `miss-tally.ts` — `latestTally()`: caught and replayed misses of the latest version replayed.
- `native-skill.ts` — `openNativeRunner()`: a skill run by the AI CLI in a work tree with the gh
  facade; `skillPolicy()`.
- `open-mcp.ts` — `openMcp()`: the declared MCP servers connected, their tools and a report.
- `propose-lessons.ts` — `proposeLessons()`: lessons asked of the AI from the misses and refused
  comments of a repository.
- `publish-saved-review.ts` — `publishSavedReview()`: a dry run of the history published, or the
  reason it is refused.
- `pull-request-fix.ts` — `readPullRequestFix()`: Phada's open comments on a pull request as
  findings to fix.
- `pull-request-work-tree.ts` — `openFreshWorkDir()`, `materializePullRequest()`: a work tree of a
  pull request head.
- `read-automation.ts` — `readAutomation()`: the watch, CI wait, request sources, hooks and when
  commands of the user config.
- `read-ci.ts` — `readCheckEntries()`, `readCi()`: the checks that count, with the annotations and
  logs of failing ones.
- `read-connections.ts` — `readConnections()`: each repository with its declared related
  repositories and package links.
- `read-conversation.ts` — `readConversation()`: the comments and review state of a pull request
  as a conversation.
- `read-history.ts` — `readReviews()`, `readFindings()`, `readFeedbackStats()`,
  `readReviewDetail()`: the history as data.
- `read-home.ts` — `readHomeLocal()`, `homeSnapshot()`: the facts the Home screen shows.
- `read-index.ts` — `readIndexes()`: the index state of each repository, read only.
- `read-learnings.ts` — `readLearnings()`: relations, feedback, misses and lessons per repository.
- `read-lessons.ts` — `readLessons()`: the pending lessons, or all, with the counts of the others.
- `read-misses.ts` — `readMisses()`: the misses of a filter, with the count of dismissed ones.
- `read-provider.ts` — `providerSetup()`, `readProviders()`: the chosen provider, its MCP servers
  and every provider checked.
- `read-queue.ts` — `readQueue()`: the watch, its repositories and its jobs, from the lock and the
  history.
- `read-repositories.ts` — `readRepositories()`, `readRepository()`: the repositories Phada knows
  and their settings.
- `read-rules.ts` — `readRules()`, `localRules()`: the rules and docs a review would read.
- `read-run-report.ts` — `readRunReport()`: every block of one run of the history.
- `read-user-repositories.ts` — `readUserRepositories()`: the token owner's repositories joined
  with the watched ones.
- `related-report.ts` — `rankOpened()`, `buildRelatedReport()`, `relatedSummaries()`: the related
  repositories for the prompt and reports.
- `related-repositories.ts` — `openRelatedRepositories()`: related repositories fetched, linked and
  indexed.
- `remembered.ts` — `remembered()`: an async read cached per key, read again after a failure.
- `replay-misses.ts` — `replayMisses()`: the open misses replayed per pull request and commit.
- `replay-reads.ts` — `replayReads()`: a `ReadGitHub` that refuses the reads a replay must not see.
- `replay.ts` — `loadReplay()`: a pull request as it was at an earlier commit.
- `reply-kinds.ts` — `ReplyCounts`, `noReplies()`, `repliedKinds()`: pure, also drawn by the app.
- `reply-to-threads.ts` — `replyToThreads()`: the replies in the threads of Phada's comments
  answered with the AI.
- `repository-folder.ts` — `findRepositoryRoot()`, `readRepositoryFolder()`: the repository of a
  folder and its `.phada/`.
- `requested-review.ts` — the types of a review asked for in the app (`ReviewMode`,
  `RequestedReview`, `HistorySave`).
- `review-and-publish.ts` — `reviewAndPublish()`: fetch, decide, review, plan, render and publish
  one pull request.
- `review-cancelled.ts` — `ReviewCancelledError`, `stopIfCancelled()`.
- `review-passes.ts` — `buildPasses()`: one pass per skill or prompt; `configuredLens()`.
- `review-progress.ts` — `ReviewProgress`: each step of a review as data.
- `review-pull-request.ts` — `reviewPullRequest()`: context, mirror, graph, related repositories,
  investigation, recheck and the engine.
- `run-target.ts` — `runTarget()`, `runPlace()`, `localRunName()`: pure, also drawn by the app.
- `select-related.ts` — `selectCandidates()`, `rankRelated()`: which related repositories a review
  opens.
- `stored-json.ts` — `parseJson()`, `objectOf()`, `stringOf()`, …: lenient reads of a stored JSON.
- `stored-report-blocks.ts` — the schemas and types of the blocks of a stored run (conversation,
  CI, posted review, passes, groups).
- `stored-review.ts` — `storedReview()`: a dry run read strictly, for publishing it.
- `stored-run.ts` — `readStoredRun()`: the run document the history keeps, decoded once into a
  lenient view; `titledFindings()`.
- `submit-request.ts` — `submitRequest()`: a review request of any source turned into a job or a
  refusal.
- `terminal-text.ts` — `toTerminalText()`, `singleLine()`: external text without control and bidi
  characters.
- `wait-for-ci.ts` — `waitForCi()`: `--wait-ci`, the wait for the checks that count.
- `watch-event.ts` — `WatchEvent`: each event of the watch as data; `watchEventsTo()`.
- `watch-repositories.ts` — `watchRepositories()`: the watch loop, from discovery to jobs, replies
  and refreshes.
- `wrap-provider-runs.ts` — `wrapProviderRuns()`: a provider whose runs report progress and stop
  once cancelled.

## `src/cli/`

The terminal edge: the commands, their wiring, and their output as text and JSON.

- `app-command.ts` — `runApp()`: the terminal app with its `AppDeps`, loaded with `import()`.
- `app-graph.ts` — `appGraph()`: symbol search for the app over one open graph explorer.
- `app-history.ts` — `appHistory()`: the history for the app, opened read-only when it exists.
- `app-index.ts` — `indexForApp()`: indexing from the app, as `phada index` does it.
- `app-review.ts` — `appReview()`: a review from the app, as `phada review` runs it.
- `app-rules.ts` — `rulesReaders()`: the rules readers of the app.
- `app-watch.ts` — `appWatch()`: the watch from the app, as `phada watch` runs it.
- `args.ts` — `parseCliArgs()`: the arguments of every command, and the help text.
- `blocked-fix.ts` — `blockedFix()`, `blockedFixer()`: the config line that allows a blocked
  command or read.
- `ci-gate-reader.ts` — `ciGateReader()`: the CI settings and checks of a job, for the CI gate.
- `ci-wait-progress.ts` — `ciWaitProgress()`: the "Waiting for CI" line.
- `classify-failure.ts` — `classifyFailure()`: an error as transient, usage limit, rate limit,
  definitive or fatal.
- `confirm.ts` — `isTerminalInput()`, `confirm()`: a yes or no on stdin.
- `context-sources.ts` — `contextSourcesAt()`: the repository at a commit and the local files.
- `coverage-label.ts` — `coverageLabel()`: the low coverage note next to the score.
- `debt-text.ts` — `debtItem()`: one line of the repository debt.
- `enqueue-command.ts` — `runEnqueue()`: `phada enqueue`.
- `errors.ts` — `UsageError`, `MissingGitHubTokenError`, `WatchRunningError`, `RunNotFoundError`,
  `PublishRefusedError`.
- `finding-references.ts` — the "Based on" line of a finding.
- `fix-wiring.ts` — `startFix()`, `reportFix()`: what the two fix commands share.
- `format-ci.ts` — the "CI:" line and the CI section of a dry run.
- `format-claims.ts` — the claims section of a dry run.
- `format-close-to-cut.ts` — the "Close to the cut" section of a dry run.
- `format-context.ts` — the context line and section of a dry run; `ruleLine()`.
- `format-conversation.ts` — the conversation line and section of a dry run.
- `format-error.ts` — `formatError()`: an error as one line and an exit code.
- `format-fix.ts` — the list, the report and the warnings of `phada fix`.
- `format-github.ts` — the review as GitHub Markdown: body, line comments, markers, replies.
- `format-groups.ts` — the diff groups section of a dry run and of `phada prompt`.
- `format-history.ts` — `phada history` as text and JSON.
- `format-impact.ts` — the impact line and section of a dry run.
- `format-index.ts` — `phada index` as text and JSON.
- `format-investigation.ts` — the "Investigated:" line and the investigation section of a dry run.
- `format-json.ts` — `formatReviewJson()`: the review as JSON.
- `format-lessons.ts` — `phada lessons` as text and JSON.
- `format-misses-replay.ts` — `phada misses --replay` as text and JSON.
- `format-misses.ts` — `phada misses` as text and JSON.
- `format-passes.ts` — the "Skills:" line and the skills section of a dry run.
- `format-prompt.ts` — `phada prompt` as text and JSON.
- `format-publication.ts` — the skip, published, recheck and resolved messages.
- `format-related.ts` — the "Related:" line and the related repositories section of a dry run.
- `format-reply.ts` — `phada reply` as text and JSON.
- `format-request.ts` — a review request, its job and its refusal as text and JSON.
- `format-review.ts` — the review as Markdown and the pull request summary; the local review.
- `format-rules.ts` — `phada rules` as text and JSON.
- `format-run-report.ts` — `phada history show`: one run of the history as text.
- `format-run-sections.ts` — `formatRunSections()`: the sections a dry run and the history share.
- `format-slack.ts` — `slackReplies()`: a review event as Slack text.
- `format-usage.ts` — the "Tokens:" line and the tokens section of a dry run.
- `format-watch.ts` — the watch events and `phada watch --status`.
- `github-access.ts` — `readGitHubAccess()`: where the token comes from and its owner, never the
  token.
- `github-token.ts` — `readGitHubToken()`, `requireGitHubToken()`, `ghTokenReader()`:
  `GITHUB_TOKEN`, `GH_TOKEN` or the gh login.
- `history-access.ts` — `existingHistory()`, `filterOf()`: what the history and misses commands
  share.
- `history-command.ts` — `runHistory()`, `runHistoryShow()`, `runHistoryPrune()`.
- `history-refresh.ts` — `refreshHistory()`: the due pull requests read again on GitHub.
- `history-run.ts` — `historyRun()`, `watchRun()`: a run as a history record.
- `i18n/en.ts` — the fixed review text in English.
- `i18n/es.ts` — the fixed review text in Spanish.
- `i18n/messages.ts` — `Messages`, `messagesFor()`: the review text of a language, English when
  unknown.
- `i18n/pt.ts` — the fixed review text in Portuguese.
- `index-command.ts` — `runIndex()`: `phada index`.
- `init-templates.ts` — the commented files `phada init` writes.
- `init.ts` — `runInit()`, `initRepository()`: `phada init`.
- `lesson-history.ts` — `withLessonHistory()`: the history opened to decide a lesson.
- `lessons-command.ts` — `runLessons()`, `runLessonsAccept()`, `runLessonsDiscard()`.
- `local-fix-command.ts` — `runLocalFix()`: `phada fix` on the last local review.
- `local-review-command.ts` — `runLocalReview()`: the wiring of a review of the local branch.
- `local-review-tools.ts` — `localReviewToolbox()`: the local review tools of `phada mcp`.
- `manual-review.ts` — `prepareReview()`, `runManualReview()`: provider choice, then
  `reviewAndPublish()` and the history save.
- `markdown-text.ts` — AI text escaped for Markdown and GitHub; `codeFence()`.
- `mcp-command.ts` — `runMcp()`: `phada mcp`, an MCP server over stdio.
- `mcp-names.ts` — `checkMcpNames()`: MCP server names checked with the AI CLI.
- `miss-replayer.ts` — `reviewReplayer()`: one replay run for `phada misses --replay`.
- `misses-command.ts` — `runMisses()`, `runMissesDismiss()`.
- `misses-replay-command.ts` — `runMissesReplay()`: `phada misses --replay`.
- `name-list.ts` — `nameList()`, `firstNames()`, `joinNames()`: the first names and "N more".
- `print-history-save.ts` — `printHistorySave()`, `savedAsLine()`: how the history kept a run.
- `print-review-progress.ts` — `printReviewProgress()`: the review progress as stderr lines.
- `progress.ts` — `liveProgress()`, `indexProgress()`: live progress lines.
- `prompt-command.ts` — `runPrompt()`, `pullRequestPrompt()`: `phada prompt`.
- `provider-choice.ts` — `loadProviderChoice()`, `assertProviderChoice()`: the provider and model
  of the flags or the config.
- `publish-command.ts` — `runPublish()`: `phada publish`.
- `publish-saved.ts` — `publishSavedRun()`: a saved dry run published and saved as a new run.
- `pull-request-fix-command.ts` — `runPullRequestFix()`: `phada fix` on a pull request.
- `queue-tools.ts` — `queueToolbox()`: the queue tools of `phada mcp`.
- `queue-wake.ts` — `sleepUntilNewJob()`: the watch's sleep, cut short by a new job.
- `read-dirs.ts` — `readDirResolver()`: `review.readDirs` as existing folders.
- `reply-command.ts` — `runReply()`: `phada reply`.
- `reply-wiring.ts` — `threadReplySetup()`, `threadReplyDeps()`, `replyOnWatchedPull()`.
- `repository-config.ts` — `effectiveConfigAt()`: the user layers merged with the repository config
  at a commit.
- `request-wiring.ts` — `submitDeps()`, `requireWatchSettings()`: the wiring of review requests.
- `review-command.ts` — `runReviewCommand()`, `runLocalReviewCommand()`: `phada review` of a pull
  request or of the local branch.
- `review-event-sinks.ts` — `openReviewEventSinks()`: hooks and Slack as destinations of review
  events.
- `review-event.ts` — `reviewEvent()`, `storedEvent()`, `eventOfJob()`: the event JSON of hooks,
  Slack and `wait_for_job`.
- `review-text.ts` — the model label and the short SHA.
- `review-wiring.ts` — `pullRequestReviewDeps()`, `ciReaders()`, `renderReview`, `reviewRunJson()`,
  `publicationCounts()`.
- `rules-command.ts` — `runRules()`: `phada rules`.
- `run-hook.ts` — `runHook()`: the hook of an event.
- `run-shell.ts` — `runShell()`: a user command through `sh`, with a deadline.
- `run-when.ts` — `whenChecker()`: the `when` command.
- `skill-catalog.ts` — `diskSkillCatalog()`: the installed skills, found by name.
- `slack-port.ts` — `slackPort()`: Slack messages to requests, job events to reactions and replies.
- `stored-ci.ts` — `ciSkipJson()`, `eventCiOf()`: the CI of a ci-failing skip, written and read
  back.
- `suppress-sqlite-warning.ts` — drops Node's warning about the built-in SQLite.
- `team-harvest.ts` — `harvestTeamComments()`: the closed pull requests of a repository read for
  lessons.
- `terminal-hand-off.ts` — `terminalHandOff()`: the terminal handed to a command, a login or the
  editor.
- `text-editor.ts` — `textEditor()`: a text edited in `$VISUAL`, `$EDITOR` or `vi`.
- `units.ts` — duration, tokens, bytes and counts.
- `user-repo-file.ts` — `ensureUserRepoFile()`: a repository's `config.yml` or `rules.md` of the
  user config.
- `watch-command.ts` — `runWatch()`: `phada watch` and `--status`.
- `watch-session.ts` — `startWatch()`: the watch with its settings, lock, history, hooks and Slack.
- `watch-status.ts` — `watchStatusText()`: `phada watch --status`.
- `watch-stop.ts` — `createStopControl()`, `trackRunningJob()`: stopping or aborting the watch.

## `src/config/`

The config files (`.phada/` in the repository and the user's own), the cache and data folders.

- `cache-paths.ts` — the cache folder and the mirror, index and observed paths of a repository.
- `data-paths.ts` — the data folder: `history.sqlite` and `watch.lock`.
- `duration.ts` — `durationMs()`: `90s`, `5m`, `1h`, `30d`.
- `errors.ts` — `ConfigError`.
- `keep-layout.ts` — `keepLayout()`: a YAML text written again with its untouched lines as they
  were.
- `layer-label.ts` — `userLayerLabel()`, `layerOrigin()`: the label of a config file.
- `lesson-draft.ts` — `lessonDraftText()`, `readLessonDraft()`: a lesson edited as YAML.
- `local-files.ts` — `LocalFileSystem` and its `node:fs` implementation; `writeNew()`,
  `writeAtomic()`.
- `mcp-servers.ts` — `userMcp()`, `resolveMcp()`: the declared MCP servers.
- `merge-config.ts` — `mergeConfig()`: the layers merged into options, rules and files, with
  origins.
- `parse-config.ts` — `parseConfigText()`: YAML into a config, or an error naming the key.
- `schema.ts` — the zod schema of `config.yml`.
- `types.ts` — `ConfigLayer`, `LayerKind`, `RulesMarkdown`.
- `user-config-edit.ts` — `planUserConfigEdit()`: a change to the user config as a plan.
- `user-config.ts` — the user config folder, `loadUserLayers()`, `listUserRepoConfigs()`.
- `watch-settings.ts` — `resolveWatchSettings()`, `historyEnabled()`: the watch settings with their
  defaults.

## `src/context/`

What the review sends besides the diff (rules, docs, CI), read through injected readers.

- `byte-cut.ts` — `byteLength()`, `cutBytes()`: a text cut at a number of UTF-8 bytes.
- `ci-log.ts` — `failedStepLog()`: the failed step of an Actions job log.
- `ci-state.ts` — `ciEntries()`, `ciSummary()`: the checks that count and the CI state.
- `ci.ts` — `buildCi()`: the checks for the AI, with annotations and logs.
- `claude-rules.ts` — `claudeRule()`: a `.claude/rules` file as a rule.
- `doc-scope.ts` — `docScope()`: when an instruction file applies.
- `frontmatter.ts` — `readFrontmatter()`: the front matter of an instruction file.
- `generated-files.ts` — `generatedFiles()`: the changed files `.gitattributes` marks generated.
- `ignore.ts` — `DEFAULT_IGNORE`, `applyIgnore()`.
- `list-context.ts` — `listContext()`: every `.phada/` folder, rule and doc of a branch.
- `load-context.ts` — `loadContext()`: the config, rules, ignore and docs in scope of a review.
- `phada-paths.ts` — the `.phada/` folders from the root to each changed file.
- `select-docs.ts` — the docs in scope, by priority, within their budget.
- `split-diff.ts` — a unified diff split by file.
- `types.ts` — `ContextReport`, `LoadedContext`, `Ci`, `CiSummary` and the other context types.

## `src/gh-facade/`

The `gh` a native skill runs: reads answered by Phada, writes captured.

- `gh-answer.ts` — `answerGh()`: reads answered, writes captured, the rest refused.
- `gh-bridge.ts` — the executable `bin/gh` runs: its call sent to the socket.
- `gh-checks.ts` — `answerChecks()`: `gh pr checks` from the checks Phada read.
- `gh-command.ts` — `parseGhCommand()`, `filesToRead()`: a `gh` command line parsed.
- `gh-jq.ts` — `applyJq()`: `--jq` with paths only.
- `gh-server.ts` — `serveGhFacade()`: the socket server, `bin/gh` and `bin/git`.
- `git-bridge.ts` — the executable `bin/git` runs: refuses or runs the real git.
- `git-guard.ts` — `gitRefusal()`: the git options a native skill may not use.
- `types.ts` — `GhPullData`, `GhCheck`, `GhCommand`, `ReadGitHub`, `GhFacadeError`.

## `src/github/`

GitHub REST and GraphQL.

- `check-runs.ts` — `fetchCheckRuns()`, `fetchCheckAnnotations()`.
- `commit-statuses.ts` — `fetchCommitStatuses()`.
- `compare-commits.ts` — `fetchComparison()`: the files changed between two commits.
- `create-review.ts` — `createReview()`: one review with its line comments.
- `errors.ts` — `GitHubError` and the typed errors.
- `graphql.ts` — `sendGraphQL()`: errors in an HTTP 200 as `GitHubGraphQLError`.
- `issue-comments.ts` — `listIssueComments()`, `addCommentReaction()`.
- `job-log.ts` — `fetchJobLog()`: the end of an Actions job log.
- `json-fields.ts` — typed reads of fields in GitHub answers.
- `list-closed-pull-requests.ts` — `listClosedPullRequests()`: pull requests closed since a time.
- `list-pull-requests.ts` — `listOpenPullRequests()`: open pull requests, with an ETag.
- `pull-request-ref.ts` — `owner/repo#N` or a pull request URL, parsed and formatted.
- `pull-request-reviews.ts` — `fetchReviewState()`, `fetchPullComments()`: reviews, threads and
  comments.
- `pull-request-timeline.ts` — `fetchPullRequestTimeline()`: commits and force-pushes.
- `pull-request.ts` — `fetchPullRequest()`, `fetchPullRequestMetadata()`, `fetchCommitDiff()`, …
- `read-repository.ts` — `repositoryReader()`: GET reads of one repository for the gh facade.
- `repository-files.ts` — `fetchRepositoryTree()`, `fetchRepositoryFile()`.
- `repository.ts` — `fetchRepository()`, `fetchBranchHead()`.
- `request.ts` — one request: headers, timeout, errors, token redaction.
- `resolve-thread.ts` — `addThreadReply()`, `resolveThread()`, `replyAndResolve()`,
  `isThreadOpen()`.
- `review-comments.ts` — `listReviewComments()`: review comments since a time.
- `user-repositories.ts` — `listUserRepositories()`: the token owner's repositories.
- `user.ts` — `fetchAuthenticatedUser()`: the token owner's login.

## `src/graph/`

The repository graph, resolved on demand from the index of a commit.

- `impact.ts` — `changedLines()`, `computeImpact()`: the changed symbols, their callers and
  dependencies.
- `linked-graph.ts` — `linkGraphs()`: callers in consumers, dependencies in publishers.
- `observe.ts` — `learnObservedEdges()`: relations learned from confirmed findings.
- `packages.ts` — `readPackages()`: what the manifests publish and depend on.
- `project-config.ts` — tsconfig paths, package.json, go.mod and Python roots.
- `report.ts` — `buildImpactReport()`: the impact for the CLI and the JSON.
- `repository-graph.ts` — `openRepositoryGraph()`: symbols, callers, dependencies and similar code.
- `repository-links.ts` — `linkRepositories()`: packages one repository publishes and another
  uses.
- `resolve-module.ts` — an import specifier to files of the commit, or external.
- `resolve-name.ts` — `NameResolver`: a call or use to its definitions.
- `similar.ts` — `scoreSimilar()`: how close two symbols are.
- `toml.ts` — `parseTomlTables()`: the strings of each TOML table.
- `types.ts` — `RepositoryGraph`, `GraphSymbol` and the other graph types.

## `src/investigation/`

Phada's read-only tools the AI calls on the pull request head, and MCP.

- `create-investigation.ts` — `createInvestigation()`: a checkout and a graph as tools per pass,
  with a log.
- `toolbox.ts` — the tools contract: `ToolDefinition`, `ToolResult`, `Toolbox`.
- `mcp/mcp-bridge.ts` — what the AI CLI starts: stdio to the socket of `mcp-server.ts`.
- `mcp/mcp-client.ts` — `connectMcp()`: an MCP client over stdio or HTTP.
- `mcp/mcp-server.ts` — the tools as a local MCP server.
- `tools/budget.ts` — calls and bytes per pass, and the answer size.
- `tools/graph-tools.ts` — `find_symbol`, `callers`, `dependencies` and `similar`.
- `tools/history-tool.ts` — `history`: commits and blame of a file.
- `tools/mcp-tools.ts` — `mcpTools()`: the tools of the connected MCP servers.
- `tools/related-repo.ts` — the `repo` argument of the tools.
- `tools/report.ts` — `buildInvestigationReport()`: what the AI read.
- `tools/repository-tools.ts` — `read_file`, `grep` and `list`.
- `tools/tool-log.ts` — `ToolLog`: one record per tool call.
- `tools/tool-registry.ts` — `createToolbox()`: validation, budget, answer size and log.

## `src/process/`

The subprocess runners and the work folders.

- `errors.ts` — `CommandError`: not found, timeout, aborted, output too large.
- `run-command.ts` — `runCommand()`, `runCommandBytes()`, `childScope()`, `killDetachedChildren()`.
- `run-interactive.ts` — `runInteractive()`: a command that owns the terminal.
- `work-dirs.ts` — `openWorkDir()`, `closeWorkDir()`, `removeOpenWorkDirs()`,
  `sweepOrphanWorkDirs()`.

## `src/providers/`

`ReviewProvider` and its implementations (Claude Code, Codex, Ollama).

- `claude-model.ts` — the model Claude Code runs.
- `claude-skill-args.ts` — the allowed tools and the temporary plugin of a Claude Code skill run.
- `claude-status.ts` — `checkClaudeStatus()`: installed and logged in, never the account.
- `claude.ts` — `ClaudeCliProvider`: `review()`, `runSkill()` and `fix()`.
- `cli-run.ts` — what the AI CLIs share: temporary folder, env without GitHub tokens, typed errors.
- `cli-status.ts` — `runStatusCommand()`: a status command of an AI CLI.
- `codex-mcp.ts` — named MCP servers as Codex `-c` settings.
- `codex-model.ts` — the model Codex runs.
- `codex-status.ts` — `checkCodexStatus()`: installed and logged in, never the key.
- `codex.ts` — `CodexCliProvider`: `review()` and `fix()`.
- `mcp-env-launcher.ts` — runs an MCP server with the env of a private file.
- `node-http-fetch.ts` — `nodeHttpFetch()`: a `fetch` over `node:http` that streams the body.
- `ollama-host.ts` — `resolveOllamaBaseUrl()`: the Ollama address from `OLLAMA_HOST`.
- `ollama-pull.ts` — `pullOllamaModel()`: a model pulled, with progress.
- `ollama-status.ts` — `checkOllamaStatus()`: running, with its models, or stopped.
- `ollama.ts` — `OllamaProvider`: `review()` over HTTP.
- `redact-secrets.ts` — token patterns removed from output kept in errors.
- `types.ts` — `ReviewProvider`, `ReviewPrompt`, `ReviewOutput`, `TokenUsage`, the provider
  errors.

## `src/publish/`

Pure: what to publish, data in, decision out.

- `conversation.ts` — `buildConversation()`: comments, reviews and threads as a conversation.
- `decide-run.ts` — `decideRun()`: review, or skip a commit already reviewed or an unchanged diff.
- `feedback.ts` — `threadFeedback()`: what happened to each of Phada's threads.
- `markers.ts` — the hidden markers of reviews, findings, resolutions and replies.
- `misses.ts` — `decideMisses()`: what people pointed out that Phada did not.
- `phada-state.ts` — Phada's own reviews and open threads.
- `plan-publication.ts` — `planPublication()`: new comments, findings still open, threads fixed.
- `recheck-candidates.ts` — `threadsToRecheck()`, `withChanges()`: Phada's older open threads to
  recheck.
- `reply-candidates.ts` — `threadsToReply()`: the threads with comments to answer.
- `state-at.ts` — `reviewStateAt()`, `commentsAt()`: the review state up to a moment.
- `thread-findings.ts` — `threadFindings()`: Phada's open threads as numbered findings.
- `types.ts` — `PublicationPlan`, `RunDecision`, `SkipReason`, `Conversation`, `ReplyKind`.
- `vanished-findings.ts` — `decideVanished()`: findings a later review lost.
- `written-line.ts` — `writtenLine()`: the line a thread was written on.

## `src/repo-map/`

The code elements of a file, with tree-sitter (WASM).

- `extract.ts` — `createExtractor()`: a file parsed into a `FileMap`, with a timeout.
- `grammars.ts` — `readGrammar()`: the tree-sitter grammars.
- `languages.ts` — `languageOf()`: a file extension to its language.
- `languages/go.ts` — the Go walker.
- `languages/javascript-like.ts` — the TypeScript, TSX and JavaScript walker.
- `languages/python.ts` — the Python walker.
- `types.ts` — `FileMap`, `ExtractedSymbol`, `SymbolKind`.
- `walk.ts` — `Collector`: symbols, imports, exports, calls and uses.

## `src/repository/`

The repository through git objects, in a persistent mirror, and the local clone a local review
reads.

- `branch-moved.ts` — `BranchMovedError`.
- `checkout.ts` — `Checkout` (read, grep, list, history), `CheckoutError`.
- `git-checkout.ts` — `GitCheckout`: one commit of the mirror; a git environment without tokens.
- `git-identity.ts` — `readGitIdentity()`: the git identity and signing settings of a folder.
- `git-mirror.ts` — `openGitMirror()`: a bare repository in the cache, fetched shallow.
- `github-auth.ts` — `gitHubAuth()`: the token as a git header, never in argv or the URL.
- `local-git.ts` — `openLocalGit()`: the repository of a folder, its branch, merge base and diff.
- `mirror-lock.ts` — `withMirrorLock()`: one fetch at a time per mirror.
- `push-fix.ts` — `commitWorkTree()`, `pushCommit()`: a fix committed as the user and pushed.
- `repo-path.ts` — `toRepoPath()`: paths inside the repository only.
- `work-tree.ts` — `materializeWorkTree()`: a checkout of the head next to the mirror.

## `src/review/`

The engine: data in, result out.

- `apply-suggestions.ts` — `applySuggestions()`: the suggestions of one file applied to its text.
- `claims.ts` — `mergeClaims()`: the claims of the description across passes.
- `context-findings.ts` — the rule and sources of each finding; the severity a rule sets.
- `continuation-prompt.ts` — `buildContinuationPrompt()`: a pass over the coverage gaps.
- `convert-prompt.ts` — `buildConvertPrompt()`: a native skill's output into Phada's report.
- `coverage.ts` — `measureCoverage()`: the files each pass covered.
- `debt.ts` — `withoutDroppedDebt()`, `separateDebt()`: findings the change did not cause.
- `diff-fingerprint.ts` — `diffFingerprint()`: the filtered diff, hashed.
- `diff-groups.ts` — `planDiffGroups()`: a large diff split into groups.
- `diff-lines.ts` — unified diff parsing and line numbering.
- `errors.ts` — `InvalidReviewReportError`, `InvalidLessonsAnswerError`.
- `finding-numbers.ts` — `numberFindings()`: the number of each finding.
- `fix-outcomes.ts` — `parseFixOutcomes()`: the outcomes of a fix answer.
- `fix-prompt.ts` — `buildFixPrompt()`: the findings to fix.
- `group-prompt.ts` — the block of a group pass.
- `impact-text.ts` — `renderImpact()`: the impact of the diff within its budget.
- `investigation-asks.ts` — `investigationAsks()`: what the prompt asks the AI to read.
- `json-objects.ts` — the top-level JSON objects of a text.
- `lessons-prompt.ts` — `buildLessonsPrompt()`.
- `lessons-schema.ts` — the zod schema of the lessons answer.
- `map-limit.ts` — `mapLimit()`: at most n calls at a time.
- `native-context.ts` — `nativeSkillContext()`, `nativeSkillTexts()`: what a native skill is told.
- `nonce.ts` — `newNonce()`: the random id of the data blocks.
- `parse-lessons.ts` — `parseLessons()`.
- `parse-report.ts` — `parseReviewReport()`.
- `parse-verification.ts` — `parseVerification()`.
- `prompt-parts.ts` — the text the review and verification prompts share.
- `prompt.ts` — `buildReviewPrompt()`: instructions, delimited data and the output schema.
- `recheck-prompt.ts` — `buildRecheckPrompt()`: earlier comments and what changed since.
- `recheck-schema.ts` — the zod schema of the recheck verdicts.
- `recheck-threads.ts` — `recheckThreads()`: a verdict per changed thread.
- `recorded-reads.ts` — `recordingReads()`: the files a pass read.
- `reimplementation.ts` — `withBackedReimplementations()`: a reimplementation finding kept only
  when backed.
- `reply-prompt.ts` — `buildReplyPrompt()`.
- `reply-schema.ts` — the zod schema of a reply.
- `reply-to-thread.ts` — `replyToThread()`: the kind and text of one reply.
- `report-schema.ts` — the zod schema of the AI report and the JSON schema sent to providers.
- `run-review.ts` — `runReview()`: passes, parsing, verification, selection and score.
- `score.ts` — `scoreFindings()`: the 0–5 score.
- `select-findings.ts` — filtering, the confidence cut, ordering, close to the cut.
- `skill-output.ts` — `skillOutputText()`, `skillBodyText()`: what a native skill wrote.
- `suggestions.ts` — `checkSuggestions()`: code suggestions checked against the diff.
- `token-usage.ts` — `sumUsage()`, `totalUsage()`, `usageReport()`.
- `types.ts` — `ReviewRequest`, `Finding`, `ReviewResult`, `ReviewOutcome` and the other engine
  types.
- `verdict.ts` — `reviewVerdict()`: clean, comments or blocking.
- `verification-schema.ts` — the zod schema of the verification verdicts.
- `verify-findings.ts` — `verifyCandidates()`, `applyVerdicts()`.
- `verify-prompt.ts` — `buildVerifyPrompt()`: the skeptical second pass.

## `src/skills/`

The skills installed for the AI CLIs, read through the `LocalFileSystem` it is given.

- `errors.ts` — `SkillError`.
- `installed-skills.ts` — `listInstalledSkills()`: user, plugin, Codex and agents skills.
- `resolve-skill.ts` — `resolveSkill()`: a skill name to one installed skill.
- `skill-locations.ts` — `skillRoots()`: where the AI CLIs keep their skills.
- `skill-text.ts` — `readSkillText()`: a skill's body and the files it names.

## `src/slack/`

Slack, and nothing else.

- `pull-links.ts` — `pullRequestLinks()`: the pull request links of a message.
- `socket-mode.ts` — `connectSocketMode()`: acks, events and reconnection.
- `web-api.ts` — `slackWebApi()`: thread replies, reactions and the Socket Mode URL.

## `src/store/`

SQLite: the index of each repository, the observed relations and the history.

- `history-columns.ts` — the history tables and their writes.
- `history-feedback.ts` — published findings, observations and the pull requests due a refresh.
- `history-harvest.ts` — the cursor of the team harvest; `runRepos()`.
- `history-lessons.ts` — `recordLessons()`, `lessons()`.
- `history-migrations.ts` — the versioned migrations of the history.
- `history-misses.ts` — `recordMisses()`, `misses()`, `dismissMiss()`, `aiRuns()`.
- `history-replies.ts` — `recordReplies()`, `classifiedComments()`, `replies()`.
- `history-store.ts` — `openHistoryStore()`: watched repositories, jobs, requests and runs.
- `index-reader.ts` — `IndexReader`: the files, symbols, calls and uses of one commit.
- `index-store.ts` — `openIndexStore()`, `openExistingIndexStore()`: the index of a repository.
- `observed-store.ts` — `openObservedStore()`, `readObservedEdges()`: relations learned from
  reviews.
- `schema.ts` — the index tables and `SCHEMA_VERSION`.

## `src/tui/`

The app `phada` opens in a terminal (Ink and React): data in, frames out. How to build a screen is
in [src/tui/README.md](../src/tui/README.md).

- `app-context.ts` — `AppDeps`: everything the app reads and runs, passed in.
- `app-watch.tsx` — `useWatchSession()`: the watch the app runs, kept across tabs.
- `app.tsx` — `App`: theme, language, load cache and error boundary around the shell.
- `config-change.tsx` — `useConfigChange()`: a change to the user config, confirmed, then written.
- `data-hooks.ts` — `usePolled()`, `useLoaded()`: local data polled, slow data loaded.
- `data-view.tsx` — `DataView`: loading, the error or the value; `failedText()`.
- `error-boundary.tsx` — `ErrorBoundary`.
- `footer.tsx` — `Footer`: the keys of the screen.
- `frame-lines.tsx` — `DrawContext`, `textLines()`, `failedNodes()`: lines of a frame.
- `hand-off.ts` — `useHandOff()`: the terminal handed to a command and back.
- `help.tsx` — `Help`: the keys of the screen and the global ones.
- `index-series.ts` — `useIndexSeries()`: repositories indexed one after the other.
- `key-hints.ts` — `fitHints()`: the keys that fit, then "? more".
- `labeled-lines.tsx` — `labeledLines()`: label and value rows.
- `language-picker.tsx` — `LanguagePicker`.
- `load-cache.ts` — `createLoadCache()`: the app's last slow loads by name.
- `login-lines.tsx` — `loginOutcomeLines()`, `aiLoginLines()`: how a login ended.
- `mascot.tsx` — `Mascot`.
- `model-pull.tsx` — `useModelPull()`: an Ollama model pulled from the app.
- `not-indexed-text.ts` — `notIndexedText()`: why a repository is not indexed.
- `open-app.tsx` — `openApp()`: the app rendered on the alternate screen until it quits.
- `palette.tsx` — `Palette`: screens and actions filtered by name.
- `provider-lines.tsx` — an AI provider as checked.
- `provider-names.ts` — `PROVIDER_NAMES`.
- `provider-picker.tsx` — `ProviderPicker`: an AI and its model chosen, logging in when needed.
- `queue-text.ts` — check names, pending checks and pause reasons as text.
- `refs.ts` — `pullRef()`, `shortSha()`.
- `refusal-text.ts` — `refusalText()`: why a review request was refused.
- `relative-time.ts` — `relativeTime()`, `absoluteTime()`, `clockTime()`.
- `repository-indexing.tsx` — `useRepositoryIndexing()`: indexing from a screen.
- `repository-picker.tsx` — `RepositoryPicker`: repositories to watch.
- `review-detail.tsx` — `reviewDetailLines()`: a review as lines.
- `review-steps.ts` — `stepsAfter()`: the review progress as one step per stage.
- `run-text.ts` — `runKey()`, `verdictLabel()`, `verdictColor()`, `sourceOf()`.
- `screens.ts` — `SCREENS`: the screens in tab order.
- `scroll-list.tsx` — `useSelection()`, `ScrollList`.
- `setting-lines.tsx` — `settingLines()`, `ruleLines()`: settings and rules with their origins.
- `sub-view.tsx` — `SubView`: a picker shown in place of a screen's view.
- `symbol-explorer.tsx` — `SymbolExplorer`: a symbol's callers and dependencies as a tree.
- `tab-bar.tsx` — `TabBar`.
- `tab-layout.ts` — `layoutTabs()`, `tabText()`: the tabs that fit.
- `terminal-size.ts` — `useTerminalSize()`, `MIN_SIZE`, `isTooSmall()`.
- `text-field.tsx` — `useTextField()`: a text input.
- `text-fit.ts` — `oneLine()`, `fit()`, `wrapText()`: text fitted to the width.
- `theme.ts` — `colorLevel()`, `resolveTheme()`: the colors the terminal supports.
- `units.ts` — duration, tokens, bytes and model size as text.
- `watch-log.ts` — `WatchLogEntry`, `appendLog()`, `watchLogText()`.
- `i18n/en.ts` — the interface text in English.
- `i18n/es.ts` — the interface text in Spanish.
- `i18n/messages.ts` — `UiMessages`, `ScreenId`, `uiMessagesFor()`: English when the language is
  unknown.
- `i18n/pt.ts` — the interface text in Portuguese.
- `review-flow/confirm-step.tsx` — the pull request and the token owner, confirmed before
  publishing.
- `review-flow/enqueue-step.tsx` — the review put in the watch's queue.
- `review-flow/flow-text.ts` — the pull request line of the flow.
- `review-flow/history-line.ts` — how the history kept a run.
- `review-flow/mode-step.tsx` — only look, or review and publish.
- `review-flow/pick-step.tsx` — a pull request or a repository typed.
- `review-flow/publish-step.tsx` — a kept dry run published.
- `review-flow/pulls-step.tsx` — the open pull requests of a repository.
- `review-flow/review-flow.tsx` — `ReviewFlow`: the stack of steps of a review from the app.
- `review-flow/run-step.tsx` — the review running, then its result.
- `screens/automation.tsx` — the Automation screen: watch, CI wait, request sources, hooks.
- `screens/graph.tsx` — the Graph screen: indexes, connections and symbol search.
- `screens/home.tsx` — the Home screen: the state of Phada and the next step.
- `screens/learnings.tsx` — the Learnings screen: relations, feedback, misses and lessons.
- `screens/provider.tsx` — the Provider screen: the AI, the language and the MCP servers.
- `screens/queue.tsx` — the Queue screen: the watch, its jobs and its log.
- `screens/repositories.tsx` — the Repositories screen: each repository and its settings.
- `screens/reviews.tsx` — the Reviews screen: the history and one review.
- `screens/rules.tsx` — the Rules screen: the lens, rules and docs, and a pull request's prompt.
- `setup/ai-step.tsx` — the AI step.
- `setup/github-step.tsx` — the GitHub step.
- `setup/graph-step.tsx` — the indexing step.
- `setup/language-step.tsx` — the language step.
- `setup/repositories-step.tsx` — the step of the repositories to watch.
- `setup/repository-step.tsx` — the `phada init` step.
- `setup/setup-steps.ts` — `SETUP_STEPS`, in order.
- `setup/setup.tsx` — `Setup`: the steps, outside the tabs.
- `setup/summary-step.tsx` — what the setup wrote, indexed and skipped.
- `setup/watched-repositories.ts` — `useWatchedRepositories()`.

## `src/watch/`

Pure: what the watch does, data in, decision out.

- `after-run.ts` — `afterRun()`: what a finished review does to its job (done, skipped,
  superseded, closed or draft, publication failed).
- `ci-gate.ts` — `ciGate()`: review, wait for CI or skip for failing CI.
- `ci-revisit.ts` — `ciRevisits()`: the ci-failing jobs to read again.
- `comment-cursor.ts` — `CommentCursor`, `advanceCursor()`: the new comments past a cursor.
- `failures.ts` — `afterFailure()`, `rateLimitPause()`: retries, pauses and failures.
- `filters.ts` — `eligibility()`: draft, bot, author, labels and base.
- `next-job.ts` — `pickNext()`: the next ready job, or until when to wait.
- `plan-cycle.ts` — `planCycle()`: what a discovery cycle queues, supersedes or drops.
- `pr-commands.ts` — `prCommands()`: `/phada review` comments as requests.
- `pull-facts.ts` — `PullFacts` of a listed or fetched pull request.
- `reply-scan.ts` — `replyScan()`: the pull requests with a new reply of a person.
- `request-policy.ts` — `decideRequest()`: a review request queued, joined or refused.
- `time.ts` — `later()`: an ISO time plus a duration.
- `types.ts` — `JobRecord`, `RequestRecord`, `PauseState`, `RunEnd` and the other watch records.

## Outside `src/`

- `scripts/copy-grammars.ts` — build step: the tree-sitter grammars into `dist/grammars/`.
- `scripts/smoke.ts` — packs the package, installs it and runs the installed `phada`.
- `docs/demo/` — the GIFs and the image the README shows.
- `test/fixtures/bin/` — fake AI CLIs (`fake-claude`, `fake-codex` and their status commands).
- `test/fixtures/github/` — trimmed GitHub responses (REST and GraphQL) and a sample diff.
- `test/fixtures/mcp/` — a fake MCP server.
- `test/support/` — shared test helpers: the fake `fetch`, fixtures, temporary git repositories,
  and the app rendered with fake deps (`tui.tsx`).
