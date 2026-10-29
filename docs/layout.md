# Layout

Every module of Phada and what it holds. Read it when looking for a module; the rules between
the folders are in [AGENTS.md](../AGENTS.md#dependency-rule).

```
src/
  bin.ts                 # entry point of the `phada` command: reads the package version, drops the
                         #   SQLite ExperimentalWarning (suppressSqliteWarning), calls run() with
                         #   the gh token reader (ghTokenReader) and the signals (SIGINT, SIGTERM)
                         #   named to the handler
  main.ts                # run(argv, deps): CLI flow — flags, token, then prepareReview() and
                         #   runManualReview() of manual-review.ts, printing the run and a
                         #   history save that failed; no command → runApp(); createProvider()
  architecture.test.ts   # allowed imports of src/review/, src/publish/, src/watch/, src/context/,
                         #   src/investigation/, src/repository/, src/repo-map/, src/store/,
                         #   src/graph/, src/app/, src/skills/, src/gh-facade/, src/slack/ and
                         #   src/tui/ (.ts and .tsx); a screen of src/tui/screens/ imports no
                         #   other screen; the app's tests wait on a condition, never a pause
  app/                   # use cases any caller can run (CLI today), with injected readers
    review-pull-request.ts # reviewPullRequest(): repository context → mirror → index of the head
                         #   (60 s budget) → related repositories → graph and impact of the diff
                         #   across them → investigation → recheck of earlier comments → review →
                         #   observed relations → reports; progress through typed events;
                         #   an aborted signal stops it between those stages (the fetch and the
                         #   index of the head take it; a cut index saves no commit);
                         #   loadPullRequestContext()
    review-cancelled.ts  #   ReviewCancelledError; stopIfCancelled(): throws it once the signal
                         #   is aborted, wrapping what a stage threw after the abort
    review-and-publish.ts # reviewAndPublish(): fetch → decideRun → context → decideRun with the
                         #   diff fingerprint → [--wait-ci: waitForCi()] → threads to recheck
                         #   (compare) → the conversation
                         #   (comments read unless conversation is off) → the checks of the head
                         #   (readCi, unless ci.read is off) → reviewPullRequest → plan → render
                         #   (injected, with the CI summary) → [checkHead] → reply and resolve
                         #   the fixed threads → createReview; never prints (the conversation
                         #   and the CI it read go out as events); an aborted signal stops it
                         #   between stages and right before publishing, never once publishing
                         #   started (ReviewCancelledError, also for what a stage threw after
                         #   the abort), and passes it into reviewPullRequest; once aborted,
                         #   no AI run of the review starts (a call to the provider throws it)
    review-progress.ts   #   ReviewProgress: each step of a review as data (fetched, conversation
                         #   and CI read, CI wait, context, indexing, related, impact, passes, the
                         #   AI running a review, verify, recheck or skill run, publishing,
                         #   warning), ReviewProgressSink; reportProgress(): ReviewProvider
                         #   decorator that reports when the AI starts and finishes a run, and
                         #   whether it answered
    wrap-provider-runs.ts #  wrapProviderRuns(): a ReviewProvider whose review and skill runs go
                         #   through a wrapper (the progress report, the refusal once cancelled)
    requested-review.ts  #   a review the person asks for in the app: ReviewMode (look, publish),
                         #   PullRequestTarget, OpenPullRequests, HistorySave, RequestedReview
                         #   (the review detail and how the history kept it, cancelled, a watch
                         #   holding the lock when it would publish, or no token), EnqueuedReview (what submitRequest() answered, or no token)
    watch-repositories.ts # watchRepositories(): the watch loop — discovery with ETags, planCycle
                         #   (asking the when command before queueing), /phada review comments,
                         #   the next job through the CI gate (readCi: waiting jobs read again
                         #   each minute, a failed read reviews at once; ci-failing skips
                         #   recorded as a run and read again each discovery cycle, the same job
                         #   queued again once they pass) with its requests,
                         #   failures and pauses, requests moved to a new commit (from a
                         #   superseded job or a ci-failing one), job events (notify; the CI
                         #   the gate read on started), the idle index and feedback
                         #   refresh (30 min per pull request, 10 per cycle); events
    watch-event.ts       #   WatchEvent: each event of the watch as data (baseline, queued,
                         #   started, waiting for CI, finished, retry, paused, failed, index,
                         #   feedback, warning, limited, refused), WatchEventSink;
                         #   watchEventsTo(): the WatchEvents of the loop → the sink; WatchEnd,
                         #   and for the app: WatchObserver (the events and each job's review
                         #   progress), WatchControl (done, stop(), abort()), WatchStarted
                         #   (started, or held by another PID)
    submit-request.ts    #   submitRequest(): a review request of any source → the policy (and the
                         #   when command) → a new job, a joined job (a ci-failing one queued
                         #   again) or a refusal; whenInput()
    feedback.ts          #   recordReviewFeedback(): the threads a run read and the comments it
                         #   published → the history; refreshFeedback(): read due pull requests
    index-repository.ts  #   indexRepository(): mirror → files left out and why → indexCommit();
                         #   with a signal, a cancel stops the fetch or stops between files
                         #   (IndexCancelled), the blobs extracted kept for the next run;
                         #   refreshIndex(): the same
                         #   within a deadline (idle watch); indexCommit(): extract new blobs
                         #   (optional deadline or signal) → store the commit; IndexingResult,
                         #   IndexingProgress: indexing as the app sees it
    repository-folder.ts #   findRepositoryRoot() (the nearest folder with .git, walking up),
                         #   readRepositoryFolder(): outside a repository, or its root with or
                         #   without .phada/; RepositoryInit
    related-repositories.ts # openRelatedRepositories(): metadata → selection → fetch of the default
                         #   branch → manifests and links → index of the linked ones (60 s in total)
    select-related.ts    #   selectCandidates() (access, empty, private on public, 20 at most),
                         #   rankRelated() (7: related to the change › linked › the rest)
    related-report.ts    #   rankOpened(), buildRelatedReport(), relatedSummaries(): the related
                         #   repositories for the prompt, the CLI and the JSON
    error-message.ts     #   errorMessage(): the message of any thrown value
    terminal-text.ts     #   toTerminalText(): strips control and bidi characters from external
                         #   text (the CLI and the app)
    wait-for-ci.ts       #   waitForCi(): the checks that count read through the CI gate (the
                         #   command's start as when Phada saw the commit, never skipping) and
                         #   slept on until it reviews; ciWaiting/ciWaited events, a failed read
                         #   ends the wait with a warning; WaitClock (now and sleep injected)
    read-ci.ts           #   readCheckEntries(): check runs and statuses → the checks that count
                         #   (ci.checks: names or globs); readCi(): + the annotations and job logs
                         #   of the failing ones → buildCi(); each failure a warning (kept on
                         #   the Ci), a permission the readers say GitHub denied
                         #   (CiReaders.permissionDenied) stops that kind of read; the logs that
                         #   are gone (CiReaders.logUnavailable) give one warning; CiReadError:
                         #   the checks of the CI gate not read, with the warnings
    read-rules.ts        #   readRules(): the context of a pull request (at its base) or of the
                         #   default branch without a review — report, ignore and the reviewer
                         #   lens — or empty; GitHub reads injected (RulesReaders); localRules():
                         #   the lens and the rules of the user config alone; NoGitHubToken,
                         #   BranchRules, PullRequestRules (the rules with the prompt) for the app
    read-queue.ts        #   readQueue(): the watch from the lock holder and the history — repos
                         #   with their last cycle, the next one estimated while a watch runs,
                         #   queued, waiting for CI, running, skipped for failing CI and failed
                         #   jobs with their requests, pause, reviews of the last hour, whether
                         #   the watch is configured and the config file to set it up in
    read-history.ts      #   readReviews(), readFindings() (destination and marks of each),
                         #   readFeedbackStats() (feedbackStats() per repository, ruleStats() per
                         #   rule), readReviewDetail(): one run with what its stored JSON keeps
                         #   (score, summary, findings, publication with what a dry run would
                         #   resolve and why a publication was skipped, CI) and the feedback of
                         #   each published finding; reviewDetailOf(): the same from a run
                         #   record (a run the app just made); no history file reads as empty
    read-repositories.ts #   readRepositories(): watch.repos ∪ the user's repos/<owner>/<repo>/
                         #   folders ∪ the history, each with its origins, index file and last
                         #   review, watched first, then own config, then history, each by
                         #   name; readRepository(): the user config with the origin of each
                         #   value (userSettings()) and each rule with its name (userRules()),
                         #   the watch filters, the index, the related
                         #   repositories declared and the last reviews; an invalid config as a
                         #   message
    read-user-repositories.ts # readUserRepositories(): the repositories of the token owner joined
                         #   with watch.repos (marked, watched first, the ones GitHub does not
                         #   list kept); no token → no-token, a failed listing → its error with
                         #   the watched ones
    read-automation.ts   #   readAutomation(): the watch, the CI wait, the request sources (Slack
                         #   with its channels and its token variables, each set or not), the
                         #   hooks and
                         #   the when commands of the top-level user config; an invalid config as
                         #   a message
    review-passes.ts     #   buildPasses(): review.prompt, review.skills or --skill → one SkillPass
                         #   per skill (paths matched here), SkillCatalog, PassPlan;
                         #   configuredLens(): the lens a config sets (built-in, prompt, skills)
                         #   and the layer that set it (layerOrigin())
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
    check-providers.ts   #   checkProviders(): the checkers of Claude Code, Codex and Ollama run
                         #   at once (injected), the chosen provider marked; one that throws is a
                         #   failed state
    read-provider.ts     #   providerSetup(): the provider and model of the user config (or the
                         #   default) and its MCP servers by name and kind, never their command,
                         #   env, URL or headers; readProviders(): the choice and every provider
                         #   checked with its nextStep() (install, login, ollama serve, ollama pull);
                         #   readProviderChecks(): every provider checked without the config;
                         #   loginCommand(): the login of Claude Code or Codex as command and
                         #   arguments; SUGGESTED_OLLAMA_MODEL (name and size)
    edit-user-config.ts  #   planUserConfig(): the user's own config.yml read (injected) →
                         #   planUserConfigEdit(); applyUserConfigPlan(): written atomically only
                         #   if the file did not change since the plan; failures as data
    read-connections.ts  #   readConnections(): each repository of the screens with its
                         #   declared related repositories (the user config and the root
                         #   .phada/config.yml of its indexed commit, merged as a review does),
                         #   each linked by package both ways, without a link, not indexed (no
                         #   index, empty, other version, unreadable, no mirror or an unreadable
                         #   one) or not read while the repository itself is not; manifests read
                         #   from the existing mirror at the index's snapshot, no fetch; readers
                         #   injected
    local-repository.ts  #   openLocalRepository(): the read-only index at its snapshot and the
                         #   existing mirror's files of that commit → packages, the root
                         #   .phada/config.yml and readText, the index kept open (or why it is
                         #   not indexed); indexedSnapshot(); declaredRelated(): the related
                         #   repositories as a review merges them; readers injected
    explore-graph.ts     #   openGraphExplorer(): the RepositoryGraph of a repository (with its
                         #   observed relations) linked with linkGraphs() to the declared related
                         #   repositories that are indexed and linked by package (each of those
                         #   linked back to it); search() → definitions, callers() and
                         #   dependencies() of one definition, routed to the graph of its
                         #   repository, LEVEL_MAX (20) per level with the count left out and
                         #   capped; close() closes every index; indexedCommit(); Explored<T>
    read-index.ts        #   readIndexes(): each repository of the screens with its index read
                         #   only (missing, other version with both, unreadable with the reason,
                         #   empty, or indexed: the latest snapshot of the default branch, its
                         #   summary, the files left out per reason with their extensions, the
                         #   size), each index closed; extensionCounts() (also phada index's);
                         #   readers injected
    read-learnings.ts    #   readLearnings(): per repository, the observed relations (newest
                         #   first; none, read or unreadable) and the feedback of Phada's comments
                         #   per repository and per rule; readers injected
    read-home.ts         #   readHomeLocal(): the config, queue, repositories, last reviews and
                         #   chosen AI as facts (each read that fails is its own error), never a
                         #   slow reader; homeSnapshot(): + the last GitHub access and provider
                         #   checks → the recommendation; GitHubAccess (where the token comes
                         #   from and its owner, never the token)
    home-recommendation.ts # recommend(): the one next step of the Home with its command — invalid
                         #   config › no token (or refused) › no user config (phada setup) ›
                         #   the chosen AI ›
                         #   paused › failed in the last day › skipped for CI › watched without
                         #   index › Slack tokens missing (no watch running) › watch stopped ›
                         #   review; "checking" while a slow fact it
                         #   could be outranked by is loading; recentFailures()
  cli/                   # terminal edge
    args.ts              #   parseCliArgs(): `setup` (--debug), `review` (--dry-run, --force, --verify/--no-verify,
                         #   --investigate/--no-investigate, --no-resolve, --no-conversation,
                         #   --no-ci, --wait-ci, --skill), `init`, `index` (--ref, --format
                         #   text|json), `rules` (--format text|json), `prompt` (--default,
                         #   --skill, --format text|json), `watch` (--once,
                         #   --backfill, --status) and `history` (--since, --limit, --stats,
                         #   --refresh, prune --older-than), `enqueue` (--publish, --format) and
                         #   `mcp` commands, --help, --version, no command (the app, --debug);
                         #   USAGE, SETUP_USAGE, REVIEW_USAGE, INIT_USAGE,
                         #   INDEX_USAGE, RULES_USAGE, PROMPT_USAGE, WATCH_USAGE, ENQUEUE_USAGE,
                         #   MCP_USAGE, HISTORY_USAGE
    app-command.ts       #   runApp(): the app when stdin and stdout are TTYs (assertAppTerminal():
                         #   else the missing command error, or --debug alone refused as an
                         #   unknown option; phada setup without them a usage error), started
                         #   on the setup for phada setup or while the user's config.yml does
                         #   not exist, on the Home otherwise (AppDeps.start), only the color variables of the environment, the
                         #   language of the user config at open and readLanguage (read on each
                         #   poll), src/tui/ loaded by import() only here
                         #   (loadApp), setInterval as the scheduler; quit 0, interrupted 130,
                         #   terminated 143, a failure thrown for formatError(); with its watch
                         #   aborted or one of its reviews still running at the end, the
                         #   process ends through abort() (as phada watch's abort), a failure
                         #   printed first; the readers of
                         #   the screens (readQueue with the lock holder and the watch settings
                         #   read on each poll, the last good ones kept, readReviews,
                         #   readReviewDetail) over appHistory() with the history opened
                         #   read-only (openHistoryReader), closed on exit;
                         #   readRepositories, readRepository (the user config folder, the index
                         #   file in the cache), readAutomation (the Slack tokens only as set or
                         #   missing), readProviderSetup (the user config read each time),
                         #   readProviders (the status checkers of src/providers/, injectable),
                         #   readLearnings (the observed files of the cache, read only),
                         #   readIndexes (the repositories of readRepositories, each index of the
                         #   cache opened with openExistingIndexStore(), openIndexReader
                         #   injectable), readConnections (each local copy opened with
                         #   openExistingGitMirror(), openExistingMirror injectable), readGitHub (readGitHubAccess()) and rulesReaders() of app-rules.ts
                         #   with one token reader that asks gh again on each load (runGh and
                         #   fetchUser injectable); handOff and the signals through
                         #   terminalHandOff(); planConfig and applyConfig (planUserConfig() with
                         #   USER_CONFIG_TEMPLATE, applyUserConfigPlan() on the local files);
                         #   pullModel (pullOllamaModel() at OLLAMA_HOST, ollamaFetch injectable);
                         #   indexRepository (indexForApp()); parsePullRequest,
                         #   readOpenPullRequests and reviewPullRequest (appReview());
                         #   pid (the app's own) and startWatch (appWatch(), the watch aborted
                         #   and awaited on exit, also when the app failed);
                         #   readRepositoryFolder and
                         #   initRepository (the app's folder, initRepository() of init.ts);
                         #   searchSymbol, symbolCallers and symbolDependencies (appGraph() over
                         #   openGraphExplorer(), openGraph injectable), closed on exit
    app-review.ts        #   appReview(): parsePullRequest (owner/repo#N or a URL, else
                         #   undefined), readOpenPullRequests (number, title, author, draft;
                         #   no token as data) and reviewPullRequest (target, look or publish,
                         #   progress sink, signal): the same prepareReview() and
                         #   runManualReview() as phada review, the AI detached, never a write
                         #   to the terminal → the review detail (reviewDetailOf() of the run's
                         #   JSON) and how the history kept it, run in its own childScope() (injectable);
                         #   publishing refused as watch-running while the lock holder says a
                         #   watch runs (read just before); reviewsRunning();
                         #   an abort kills the detached children of that scope only and ends as cancelled,
                         #   with no history row; enqueueReview: the watch settings
                         #   (requireWatchSettings()), the token and submitRequest() (source
                         #   enqueue, publish pr) over the history, as phada enqueue
    app-watch.ts         #   appWatch(): start (the lock held by another PID as data, else
                         #   startWatch() of watch-session.ts as phada watch runs it, never once
                         #   and without backfill, inside its own childScope(), whose kill() is
                         #   the session's killDetachedChildren; warnings as warning events,
                         #   both progress sinks of a job to the observer) → WatchControl;
                         #   close(): a start under way awaited, a running watch aborted and
                         #   its end awaited → idle, or aborted when a watch ended aborted;
                         #   startWatch and childScope injectable
    app-index.ts         #   indexForApp(): token, user layers, mirror and index of the cache as
                         #   phada index uses them → indexRepository() with the signal and the
                         #   progress (fetching, extracting); no token and failures as data
    terminal-hand-off.ts #   terminalHandOff(): handOff (a command, the login of an AI CLI
                         #   without the GitHub tokens, or a file in $VISUAL › $EDITOR › vi split
                         #   on spaces, run in the app's folder with its environment, the
                         #   app's stdin paused first so every key goes to the command, and
                         #   the cursor back at the line start after it, where the app redraws;
                         #   runInteractive injectable) and the app's signals: SIGINT ignored
                         #   while the command runs (Ctrl-C is the command's), SIGTERM ends the
                         #   command and the app
    app-rules.ts         #   rulesReaders(): readLocalRules (the user config), readRepositoryRules
                         #   (the default branch) and readPullRequestRules (readRules at the base
                         #   and pullRequestPrompt(), the pull request and the repository files
                         #   read once) with the token of the reader it is given, no-token
                         #   without one
    app-graph.ts         #   appGraph(): searchSymbol, symbolCallers and symbolDependencies over
                         #   one open GraphExplorer at a time (another repository closes it, a
                         #   search reopens it when the index has a new commit), closed with
                         #   the app
    app-history.ts       #   appHistory(): the history for the app, opened once when its file
                         #   exists (looked for again while missing, never created), a newer,
                         #   older or unreadable file thrown on each read and looked at again
                         #   on the next
    init.ts              #   runInit(): .phada/ in the repository, or the user's own config;
                         #   initRepository(): .phada/ at the root and each file created or kept
    init-templates.ts    #   the commented files phada init writes; userRepoConfigTemplate(): the
                         #   header of a repository's own config.yml the app creates
    user-repo-file.ts    #   ensureUserRepoFile(): repos/<owner>/<repo>/config.yml or rules.md of
                         #   the user config folder, created from its template when missing (a
                         #   name that is not owner/repo refused), for the app's editor
    index-command.ts     #   runIndex(): token, cache folder, mirror, progress, the map's report
    rules-command.ts     #   runRules(): token, user config, readRules() for a pull request or
                         #   the default branch, printed as text or JSON
    prompt-command.ts    #   runPrompt(): the built-in prompt, or the prompt of a pull request
                         #   with its conversation and checks (as the config turns them on);
                         #   pullRequestPrompt(): that prompt for a fetched pull request (also
                         #   the app's)
    format-prompt.ts     #   formatPromptText(), formatPromptJson() (schemaVersion 1)
    skill-catalog.ts     #   diskSkillCatalog(): the installed skills, listed once, found by name;
                         #   claude:<name> for a skill built into Claude Code
    blocked-fix.ts       #   blockedFix(), blockedFixer(): the config line that allows a blocked
                         #   command or read
    read-dirs.ts         #   readDirResolver(): review.readDirs → existing folders (~ expanded)
    format-passes.ts     #   the "Skills:" line and the skills section of --dry-run
    watch-command.ts     #   runWatch(): --status, or the watch through startWatch() with its
                         #   events as lines, Ctrl-C once (stop) or twice (abort, exit 130)
    watch-session.ts     #   startWatch(): settings, providers checked on start, lock, history,
                         #   hooks and Slack, the watch deps, one job's review → a WatchHandle
                         #   (done, stop(), abort(), the running job); the watch events, warnings
                         #   and each job's review progress as data, never printing
    ci-gate-reader.ts    #   ciGateReader(): the ci settings of a job (user config and the root
                         #   .phada/config.yml at the base merged with mergeLayers(), read once
                         #   per job) and the checks
                         #   that count of its head and onFailure, for the CI gate; none with
                         #   ci.read: false, or ci.wait: 0s with onFailure: review; CiReadError
                         #   when they were not read
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
                         #   and the checks that count once the review (or, on review.started,
                         #   the CI gate of the watch) read them
    run-shell.ts         #   runShell(), shellFailure(): a command of the user through sh, with its
                         #   own process group and a deadline
    run-hook.ts          #   runHook(): the hook of an event, its failure as a warning
    run-when.ts          #   whenChecker(): the when command, its refusal as a message
    queue-wake.ts        #   sleepUntilNewJob(): the watch's sleep, cut short by a new ready job
    slack-port.ts        #   slackPort(): Slack messages → requests; job events → reactions (the
                         #   queued mark swapped for the verdict, the skipped one too unless
                         #   another pull request of the message still ends skipped) and
                         #   replies in the thread
    format-slack.ts      #   slackReplies(): the event as Slack text (link, summary, full, the
                         #   failing checks of a ci-failing skip), split
    watch-stop.ts        #   createStopControl(): stop (finish the review) or abort (kill the
                         #   children, put the running job back, close); trackRunningJob(): the
                         #   job an abort puts back
    watch-status.ts      #   watchStatusText(): readQueue() as --status in text or JSON
    history-command.ts   #   runHistory() (list, stats, --refresh) over the history use cases,
                         #   runHistoryPrune(); the history opened only when its file exists
    format-history.ts    #   formatHistoryText/Json(), formatStatsText/Json() (schemaVersion 1)
    format-watch.ts      #   formatWatchEvent(), formatWatchStatus(), formatWatchStatusJson(); a
                         #   job waiting for CI with its deadline and pending checks, skipped
                         #   for failing CI or back in the queue
    provider-choice.ts   #   assertProviderChoice(): known provider, model for ollama, no MCP
                         #   server names with ollama; providerRunsSkills()
    mcp-names.ts         #   checkMcpNames(): MCP server names checked with `claude mcp get` or
                         #   read with `codex mcp get --json` before the review
    classify-failure.ts  #   classifyFailure(): an error → transient, usage-limit, rate-limit,
                         #   definitive or fatal
    review-wiring.ts     #   pullRequestReviewDeps() (its progress to a ReviewProgressSink),
                         #   reviewAndPublishEvents(), ciReaders(), renderReview, reviewRunJson():
                         #   shared by review, watch and prompt
    manual-review.ts     #   prepareReview(): user layers, provider and model (flags › config),
                         #   MCP servers resolved and their names checked; runManualReview():
                         #   reviewAndPublish() (mode manual, the signal also cutting the CI
                         #   wait) with its deps and progress, then
                         #   the run saved in the history when it is on, with its feedback
                         #   (HistorySave); shared by phada review and the app
    history-run.ts       #   historyRun(), watchRun(): a run, a failure or a ci-failing skip →
                         #   the history record
    stored-ci.ts         #   ciSkipJson(), storedCi(): the CI of a run in its stored JSON, written
                         #   for a ci-failing skip and read back (validated) for the events
    format-rules.ts      #   formatRulesText() (a pull request's title "at base <sha>"),
                         #   formatRulesJson() (schemaVersion 1)
    context-sources.ts   #   contextSourcesAt(): the repository at a commit and the local files
    format-index.ts      #   formatIndexText(), formatIndexJson() (schemaVersion 1)
    suppress-sqlite-warning.ts # drops Node's ExperimentalWarning for the built-in SQLite
    errors.ts            #   UsageError, MissingGitHubTokenError, WatchRunningError
    github-token.ts      #   readGitHubToken(), requireGitHubToken(): GITHUB_TOKEN › GH_TOKEN › the
                         #   gh login; findGitHubToken(): the token and where it came from;
                         #   ghTokenReader(): gh auth token, or gh auth status
                         #   --show-token on an old gh, asked once, no token on any failure
    github-access.ts     #   readGitHubAccess(): where the token comes from and its owner's login,
                         #   a refused token (401) or the error of the read; never the token
    format-review.ts     #   pull request summary (stderr) and the Markdown review (stdout)
    format-github.ts     #   the review as GitHub Markdown: body (the CI line under the score),
                         #   line comments, suggestion blocks, markers, truncation; formatResolvedReply(); formatGitHubPreview() for
                         #   --dry-run
    format-publication.ts #  skip, "Published", recheck and "Resolved" messages
    format-context.ts    #   the "Context at base <sha>:" line and the context section of
                         #   --dry-run
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
                         #   conversation (each item without its texts, with its bytes), ci,
                         #   investigation, impact and recheck blocks
    markdown-text.ts     #   escapes AI text: block markers; for GitHub also HTML and mentions;
                         #   codeFence()
    review-text.ts       #   model label and short SHA
    i18n/                #   fixed review text per language: messages.ts (Messages, messagesFor()),
                         #   en.ts, pt.ts, es.ts; unknown languages fall back to English
    format-error.ts      #   error → one line + exit code (2 usage, 1 failure); --debug details
    progress.ts          #   liveProgress(): a line with a live timer on a TTY, one line
                         #   otherwise; indexProgress(): the "Indexing N files…" lines
    print-review-progress.ts # printReviewProgress(): the review progress as the stderr lines of
                         #   review and watch
    ci-wait-progress.ts  #   ciWaitProgress(): "Waiting for CI… 3m12s, 2 pending: …" live on a
                         #   TTY, one line at the start and one at the end otherwise
    units.ts             #   duration, tokens, bytes, counts
    name-list.ts         #   nameList(), firstNames(), joinNames(): the first 5 names and "N more"
  tui/                   # the app `phada` opens in a terminal (Ink + React), data in, frames out
    open-app.tsx         #   openApp(deps, host): renders <App> on the alternate screen (render
                         #   injected), Ctrl-C handled by the app, SIGINT/SIGTERM through
                         #   host.onSignal → the quit guards aborted → unmount → AppResult (quit,
                         #   interrupted, terminated, failed with the error)
    app.tsx              #   App: theme, catalog of the language read every 2 s and at once after
                         #   a config write (the last good one kept), working signal, load cache
                         #   and error boundary around the shell — tabs, the active screen, or
                         #   the setup in their place (AppDeps.start, /setup from its first step) or the
                         #   LanguagePicker (/language, back to the screen it came from), the
                         #   ReviewFlow (/review, n in Reviews, v in Repositories through
                         #   useStartReview(), back to the screen it came from), /index
                         #   to the Graph tab, /watch to the Queue (starting or asking to stop
                         #   the watch), the watch session of the app (useWatchSession(), above
                         #   the screens), footer,
                         #   ? help, / palette, Esc (a screen's back first), q, 1–9, ←/→, Tab
                         #   (not in the setup), Ctrl-C; the quit guard: with a guard held, q,
                         #   Esc at the top and Ctrl-C ask its question (Enter stops each guard
                         #   and quits once they stopped, Esc stays, a second Ctrl-C aborts and
                         #   exits interrupted), a signal aborts them; the size warning below
                         #   80×24
    app-context.ts       #   AppDeps (version, start, debug, cwd, home, env, scheduler, language, now,
                         #   readLanguage, readQueue, readReviews, readReviewDetail, readRepositories,
                         #   readRepository, readAutomation, readIndexes, readConnections,
                         #   searchSymbol, symbolCallers, symbolDependencies, readProviderSetup,
                         #   readProviders, readLearnings, readGitHub, readLocalRules, readRepositoryRules,
                         #   readPullRequestRules, handOff, planConfig, applyConfig,
                         #   ensureRepositoryFile, parsePullRequest, readOpenPullRequests,
                         #   reviewPullRequest, enqueueReview, pid, startWatch), AppStart,
                         #   HandOffTarget, HandOffResult, Scheduler, KeyHint;
                         #   useAppDeps(), useTheme(), useMessages(), useConfigWritten() (the
                         #   language read again at once), useStartReview() (the review flow
                         #   in place of the tabs, on a repository's open pull requests when
                         #   given one), useQuitGuard() (QuitGuard: the question, stop() and
                         #   abort() of something running, held while given), useWorking(),
                         #   useIsWorking(), useScreenKeys(), useBack(), useScreenInput() (quiet
                         #   while a text field is focused), useArrowKeys() (← and → to the
                         #   screen, Tab still moves between screens), useScreenSize()
    screens.ts           #   ScreenDefinition (id, title from the catalog, Screen) and SCREENS,
                         #   in tab order
    screens/             #   one file per screen: home.tsx (the box with the mascot, version and
                         #   folder under ~ cut to the width; GitHub, AI, watch, queue and graph
                         #   in one line each, the recommendation with its command and the last
                         #   reviews that fit; local facts every 2 s, GitHub and the AI checks on
                         #   open and on r), queue.tsx (the watch from the lock — in this app
                         #   (the lock holder is AppDeps.pid), in another terminal with its PID,
                         #   or not running, w starts it — and the history, its jobs by kind
                         #   (the running one with the step of its review in this app) → a job
                         #   with its requests; w starts the watch here (no hint while another
                         #   terminal holds the lock; why it did not start wrapped), or asks
                         #   before stopping it after the current review; the newest lines of
                         #   its log under the jobs, l → the whole log wrapped, from its end;
                         #   queueRows()), reviews.tsx (the history with a text filter → one
                         #   review drawn by reviewDetailLines(); n reviews a pull request),
                         #   repositories.tsx (each repository with its origins, index and last
                         #   review → its watch filters, index, user config with origins, rules,
                         #   related repositories and last reviews; on the selected one w
                         #   watches or unwatches, p turns publish on or off, e and R open its
                         #   own config.yml and rules.md in the editor (ensureRepositoryFile),
                         #   a → the RepositoryPicker in a SubView; w, p and a hidden while the
                         #   user config is invalid; i indexes the selected or open one; v
                         #   reviews one of its open pull requests),
                         #   graph.tsx (each repository's index state, commit, files, symbols
                         #   and size from readIndexes (loaded, r, read again after indexing) →
                         #   its index section: when, commit and branch, duration, files per
                         #   language, symbols by kind, links, files left out, file; missing,
                         #   other version, unreadable or empty as a line; the linked count of
                         #   each one and its connections section from readConnections (loaded,
                         #   r, read again after indexing): each declared related repository with
                         #   its packages each way, no link or why it is not indexed, or how to
                         #   declare them; i indexes or indexes again, I indexes the related
                         #   repositories not indexed, Esc stops; s in the detail → a symbol
                         #   name → the SymbolExplorer in a SubView), automation.tsx (one page:
                         #   watch, CI wait, request sources, hooks, when), provider.tsx (the
                         #   choice and its origin, the language, each AI checked on open and on
                         #   r with its next step, l to log in to the chosen CLI (again, when
                         #   logged in), else to a logged-out CLI, and checked again on return, the MCP servers; c → the
                         #   ProviderPicker and L → the LanguagePicker in a SubView, back on save
                         #   or Esc with the AIs checked again; none while the config is
                         #   invalid, when the AIs are checked without it), learnings.tsx (each
                         #   repository's relations and feedback → its feedback per rule and its
                         #   relations), rules.tsx (a repository → the lens and who set it, the
                         #   user's rules at once, .phada/ and docs of the default branch on open
                         #   and on r; p and a number → the loaded rules of that pull request and
                         #   its prompt: each pass, its data blocks and instructions)
    setup/               #   the setup, outside the tabs: setup.tsx (Setup: "step n of 7" and the
                         #   step's title, s skips, Esc asks to leave (a step's back first),
                         #   s hidden while the step holds Esc; y/Enter → Home; each step drawn as a screen in a smaller area, its
                         #   keys and back gathered by the setup), setup-steps.ts (SETUP_STEPS
                         #   in order, SetupStep, SetupStepProps: progress and next(result): the
                         #   config written, the indexing and the init of the step),
                         #   github-step.tsx (where the token comes from and its owner; no token
                         #   or a gh token refused → Enter runs gh auth login and checks again;
                         #   gh missing → install it or export GITHUB_TOKEN), ai-step.tsx (the
                         #   ProviderPicker → the change → written), repositories-step.tsx (the
                         #   RepositoryPicker → the change → written; no token → Enter goes
                         #   on), language-step.tsx (the LanguagePicker → written),
                         #   graph-step.tsx (useWatchedRepositories();
                         #   Enter indexes them in series with useIndexSeries, "N of M files",
                         #   Esc stops; each one indexed, stopped, not started or failed in one
                         #   line; none watched → Enter goes on), repository-step.tsx (the
                         #   app's folder: in a repository without .phada/ Enter runs phada init
                         #   and shows each file; outside one or with .phada/, Enter goes on),
                         #   summary-step.tsx (the values written and their file, what was
                         #   indexed, left for later or not, the files phada init created, the
                         #   steps skipped, phada watch when a repository is watched and phada
                         #   review; Enter → Home), watched-repositories.ts
                         #   (useWatchedRepositories(): watch.repos of readRepositories, an
                         #   invalid config as failed)
    config-change.tsx    #   useConfigChange(onSaved): propose(changes) → AppDeps.planConfig →
                         #   the before → after to confirm (Enter writes, cancel() on Esc) or the
                         #   refusal; a file changed since the plan planned again on Enter;
                         #   configChangeLines(), valueChangeLines() (one line per value, and a
                         #   line when the file is rewritten in a standard layout)
    setting-lines.tsx    #   settingLines(), settingValue(): config settings as key, value and
                         #   origin rows; ruleLines(): the user's rules as name, text and origin
                         #   rows; indented()
    provider-names.ts    #   PROVIDER_NAMES: the name of each AI provider as the screens show it
    provider-lines.tsx   #   statusParts(), stateIcon(), modelsLine(), nextStepLine(): an AI
                         #   provider as checked
    login-lines.tsx      #   loginOutcomeLines(): the end of a login handed to its CLI (an AI CLI
                         #   or gh) as wrapped lines; aiLoginLines(): an AI CLI's login judged by
                         #   the check after it (still logged out → not completed, whatever the
                         #   exit code), by the exit code while that check runs
    provider-picker.tsx  #   ProviderPicker: the AIs as checked (r) → ↑/↓ Enter: a logged-out CLI
                         #   logs in (handed over, checked again), a ready CLI → its default
                         #   model (model unset) or a typed one, a running Ollama → an installed
                         #   model, the suggested one or a typed one (pulled first when missing,
                         #   the models in a ScrollList) → the change of provider and model
                         #   (useConfigChange); Esc goes back
    repository-picker.tsx #  RepositoryPicker: AppDeps.readUserRepositories (loaded, r) as a list
                         #   with watch.repos marked; f filters it, Space marks, a adds a typed
                         #   owner/repo; Enter → watch and unwatch changes (useConfigChange), or
                         #   onContinue when nothing changed; a failed listing in one line, the
                         #   typed field still there
    language-picker.tsx  #   LanguagePicker: en, pt, es with the current one marked → the change
                         #   of language (useConfigChange) → onDone(plan), the app speaking it at
                         #   once; the current one picked → onDone() without writing; a config
                         #   it cannot read → its error, no choice; languageName()
    sub-view.tsx         #   SubView: a picker shown in place of a screen's view, its keys and back
                         #   gathered, Esc (when the picker does not hold it) → onLeave()
    symbol-explorer.tsx  #   SymbolExplorer: searchSymbol (loaded, r) → several definitions to
                         #   pick, or the tree of one: Callers and Dependencies, Enter/→ opens a
                         #   node one level (a caller into its callers, a dependency into its
                         #   dependencies) with loading on it, ← closes it, +N and the cut;
                         #   not found or not indexed as a line with i to index
    not-indexed-text.ts  #   notIndexedText(): why a repository is not indexed, in one line
    index-series.ts      #   useIndexSeries(): AppDeps.indexRepository one repository after the
                         #   other with an AbortController (stop() cancels the current one and
                         #   starts no other; aborted on unmount), each one waiting, running with
                         #   its progress or done; a new series once the last one ended
    repository-indexing.tsx # useRepositoryIndexing(onEnded): repositories indexed through
                         #   useIndexSeries (start, stop, busy, the Esc key while busy, their lines);
                         #   indexEntryLine(): a repository of a series in one line (also the
                         #   setup's graph step)
    model-pull.tsx       #   useModelPull(onPulled): AppDeps.pullModel with an AbortController
                         #   (cancel(), aborted on unmount); modelPullLines(): the status, a bar
                         #   with bytes and percent, and how it ended
    units.ts             #   durationText(), bytesText(), modelSizeText() (decimal, as Ollama)
    run-text.ts          #   runKey(), verdictLabel(), verdictColor(), sourceOf(): a run of the
                         #   history as the screens list it
    data-hooks.ts        #   usePolled() (local data, at once, every 2 s on the scheduler and when
                         #   its key changes), useLoaded(key) (slow data through the load cache:
                         #   the last value at once, loaded again on open after 30 s and on r;
                         #   loading while a load runs); DataState
    load-cache.ts        #   createLoadCache(): the app's last slow loads by name (GitHub, the AI
                         #   checks, rules per repository and pull request), a running load
                         #   joined, fresh for FRESH_MS on the app's clock; LoadCacheContext
    hand-off.ts          #   useHandOff(): AppDeps.handOff inside Ink's suspendTerminal() (the
                         #   app leaves the alternate screen and raw mode, redraws on return);
                         #   one at a time, a throw as a failed outcome
    data-view.tsx        #   DataView: loading, the error wrapped, or the value; failedText():
                         #   any error as one line without control characters (in "Could not
                         #   load" or the catalog sentence it is given); failedLines():
                         #   that line (or the catalog sentence it is given) wrapped over
                         #   ERROR_LINES at most
    scroll-list.tsx      #   useSelection() (↑/↓, PgUp/PgDn, Home/End, Enter; follows the selected
                         #   key when the list changes; initialKey, select(key)), ScrollList (the rows that fit and
                         #   "n–m of N"), ScrollText (lines that scroll, from the start or
                         #   following the end); listWindow()
    text-field.tsx       #   useTextField() (every key while focused, Enter applies, Esc leaves;
                         #   a write of several keys taken in order; switched after the key that
                         #   asked; emptyOnFocus opens it empty), TextFieldLine
    text-fit.ts          #   oneLine() (toTerminalText on one line), namesText() (the first names
                         #   and "+N"), fit() (pad or cut with …, at the end or the start),
                         #   wrapText() (at most maxLines, the last cut with …), errorLines()
                         #   (an error over ERROR_LINES), shortenHome() (a path under ~)
    frame-lines.tsx      #   DrawContext (catalog, theme, width); textLines() (a text wrapped, one
                         #   node per line), failedNodes() (failedLines() in the error color),
                         #   spaced() (a blank line before lines), Lines (each cut at the width),
                         #   errorDetailNodes() (an error's stack and causes, for --debug, cut
                         #   to the rows)
    labeled-lines.tsx    #   labeledLines(): label and value rows of a detail, values wrapped
    relative-time.ts     #   relativeTime() ("2m ago", "in ~4m" for an estimate), absoluteTime(),
                         #   clockTime() (HH:MM:SS);
                         #   TimeMessages
    tab-bar.tsx          #   TabBar: the active tab inverse, or in brackets without colors (+
                         #   tab-layout.ts: layoutTabs(): full › short › a window with ‹ ›; tabText())
    footer.tsx           #   Footer (+ key-hints.ts: fitHints(): the keys that fit, then "? more")
    help.tsx             #   Help: the screen's keys and the global ones
    review-flow/         #   ReviewFlow (review-flow.tsx): a stack of steps, one file each — a
                         #   typed pull request (refused when it is not one) or a repository
                         #   (pick-step.tsx) → its open pull requests (pulls-step.tsx, loaded,
                         #   r) → only look or review and publish (mode-step.tsx; put in the
                         #   queue while a watch holds the lock, from readQueue) → for
                         #   publishing, the pull request and the token owner to confirm (and
                         #   the watch's PID) (confirm-step.tsx) → the steps live with the
                         #   mascot and the AI's time on the app clock, a closed or draft
                         #   pull request said under it (reviewed anyway), warnings → the result
                         #   (time, history, warnings, reviewDetailLines()), cancelled or the
                         #   error (run-step.tsx; a watch found holding the lock when it would
                         #   publish goes back to the confirmation, as putting it in the queue);
                         #   or the queued or joined job or the refusal, Enter to the Queue
                         #   (enqueue-step.tsx); Esc goes one step back, asks to cancel while
                         #   it runs (not once publishing), out once it ended; a quit guard
                         #   while it runs; flow-text.ts: the pull request line
    review-steps.ts      #   stepsAfter(): the review progress events → one step per stage
                         #   (fetch, with a closed or draft notice, context, conversation,
                         #   CI, CI wait, indexing, related, impact, skill pass, each AI run
                         #   with its start and end, publishing) and the warnings;
                         #   stepRunning(), stepFailed() (an AI
                         #   run with no answer); stepText(): a step as the review flow and
                         #   the Queue show it
    refs.ts              #   pullRef() (owner/repo#N), shortSha(): through oneLine()
    refusal-text.ts      #   refusalText(): why a review request was refused, from the catalogs
    queue-text.ts        #   checkNames() (the first 3 checks and "+N"), pendingText(),
                         #   pauseReasonText(): the Queue screen and the watch log
    app-watch.tsx        #   useWatchSession() (held by the shell above the screens, so tabs
                         #   and the review flow keep it): the phase (idle, starting, running,
                         #   stopping), a notice (held by another PID, or why it did not
                         #   start), the log, the running job with its review steps, the stop
                         #   question; toggle(holder), confirmStop(), keepRunning(); a quit
                         #   guard while it runs (stop: after the current review, awaited;
                         #   abort: the watch's abort()); AppWatchContext, useAppWatch()
    watch-log.ts         #   WatchLogEntry (the app clock and an event, or the watch started,
                         #   stopping or ended), appendLog() (the last MAX_LOG_LINES, 200),
                         #   watchLogText() (the time and the line from the catalogs, external
                         #   text through oneLine()), watchLogTone()
    review-detail.tsx    #   reviewDetailLines(): a review as lines — pull request and link,
                         #   score, verdict, status, when, CI, publication (nothing posted,
                         #   would resolve, would skip and why), summary, findings with their
                         #   body, worth checking, feedback (Reviews and the review flow)
    palette.tsx          #   Palette: screens, the setup, the language, review, index and watch
                         #   (/watch: the Queue, and the watch started or the stop question) filtered by name (the catalog's and
                         #   English, without accents), ↑/↓, Enter, Esc; matchEntries()
    mascot.tsx           #   Mascot: the two frames, flapping on the scheduler while working
    terminal-size.ts     #   SizeSource, outputSize() (columns, rows, 'resize'), useTerminalSize(),
                         #   MIN_SIZE, isTooSmall()
    theme.ts             #   colorLevel(env) (NO_COLOR › FORCE_COLOR › TERM=dumb › COLORTERM ›
                         #   256color › 16); resolveTheme(): the Violeta tokens as hex, the nearest
                         #   xterm-256 color, a named 16 color or none
    error-boundary.tsx   #   ErrorBoundary: a render error → onError, nothing drawn
    i18n/                #   interface text per language: messages.ts (UiMessages, ScreenId,
                         #   uiMessagesFor()), en.ts, pt.ts, es.ts; unknown languages fall back to
                         #   English
  config/                # the config files: .phada/ in the repository and the user's own
    schema.ts            #   Zod schema of config.yml (ci: read, wait, onFailure, checks);
                         #   LANGUAGE_TAG
    parse-config.ts      #   parseConfigText(): YAML → config or an error naming the key
    merge-config.ts      #   mergeConfig(): layers → options, rules, files, ignore with origins (pure),
                         #   the ci settings with DEFAULT_CI (read, 15 min wait, onFailure: review)
                         #   for what no layer sets; resolveProvider(): provider and model as a pair
    mcp-servers.ts       #   userMcp(), resolveMcp(): MCP server names and declared servers, with
                         #   ${VAR} expanded from the environment
    user-config.ts       #   the user's folder (PHADA_CONFIG_HOME › XDG › ~/.config/phada),
                         #   userConfigFile(), loadUserLayers(), loadTopLevelUserLayers();
                         #   listUserRepoConfigs():
                         #   the repos/<owner>/<repo>/ folders with a config.yml or rules.md
    user-config-edit.ts  #   planUserConfigEdit(): changes (provider, model, language, watch.repos,
                         #   publish of a watched repository) on the text of a user config with its
                         #   comments and order → the new text (a new file on top of the template)
                         #   and the changes by value, checked with the schema; the lines the
                         #   change leaves alone kept as written (keepLayout()), else the file
                         #   rewritten and marked reformatted; an invalid config, ollama without a
                         #   model in a change of provider or model, or the last watched repository
                         #   while other watch settings remain, refused
    keep-layout.ts       #   keepLayout(): a YAML text rendered again → the lines it did not change
                         #   as written (spacing, flow padding), a changed line keeping the column
                         #   of its comment; reformatted when a line could not be kept
    layer-label.ts       #   userLayerLabel(), layerOrigin(): the label of a user config file
                         #   (user:…, user:repos/<owner>/<repo>/…) and back to global, repository
                         #   or a file of the repository, with its name
    local-files.ts       #   LocalFileSystem and its node:fs implementation; writeNew(): a file
                         #   created only when missing; writeAtomic(): a temporary file in the
                         #   same folder renamed over the file (over the file a link points to,
                         #   keeping the link)
    cache-paths.ts       #   the cache folder (PHADA_CACHE_HOME › XDG › ~/.cache/phada),
                         #   repositoryCache(): mirror, index and observed paths; pathSize();
                         #   observedFile(); observedRepositories(): owner/repo of each observed
                         #   file
    data-paths.ts        #   the data folder (PHADA_DATA_HOME › XDG › ~/.local/share/phada):
                         #   history.sqlite and watch.lock
    watch-settings.ts    #   resolveWatchSettings() with the defaults, historyEnabled()
    duration.ts          #   durationMs(): 90s, 5m, 1h, 30d
    errors.ts            #   ConfigError
  context/               # what the review sends besides the diff, with injected readers
    phada-paths.ts       #   .phada/ folders from the root to each changed file
    split-diff.ts        #   a unified diff split by file
    ignore.ts            #   DEFAULT_IGNORE (lockfiles, minified files, source maps), applyIgnore()
    byte-cut.ts          #   byteLength(), cutBytes(): a text cut at a number of UTF-8 bytes with
                         #   the "[truncated by Phada: …]" line (docs, CI and conversation)
    select-docs.ts       #   docs by priority (including other tools' instruction files), the
                         #   60 KB budget, cutting a doc at 20 KB
    frontmatter.ts       #   readFrontmatter(): the front matter of an instruction file, line by line
    claude-rules.ts      #   claudeRule(): a .claude/rules file → a rule named by its path, its
                         #   paths: as the scope (every file without it or with an unreadable
                         #   front matter), the body cut at 20 KB; CLAUDE_RULES_GLOB
    doc-scope.ts         #   docScope(): always, globs, manual or excluded, from applyTo, globs,
                         #   alwaysApply, description and excludeAgent
    load-context.ts      #   loadContext(): config files, rules (with the .claude/rules) in scope,
                         #   ignore, docs in scope → ReviewContext + report; readClaudeRules()
    list-context.ts      #   listContext(): every .phada/ folder, rule (.claude/rules included)
                         #   and candidate doc of a branch, and its review settings
    ci-state.ts          #   ciEntries(): check runs (the latest run of each name) and commit
                         #   statuses → the checks that count,
                         #   passing, failing or pending; ciSummary(): the CI state (none, pending,
                         #   passing, failing) and the names of the failing and pending checks
    ci-log.ts            #   failedStepLog(): an Actions job log → its failed step, without
                         #   timestamps or colors, the final 8 KB; a cut counted on a CutCount
    ci.ts                #   buildCi(): the checks for the AI (failing › pending › passing) with
                         #   title, summary, annotations (failure and warning, 50 in total) and
                         #   the failed step of the log (12 KB in total), the entries as read, the
                         #   summary and the report; ciLogsLeft(); keepsAnnotation() and
                         #   CI_MAX_ANNOTATIONS (what read-ci.ts fetches)
    types.ts             #   ContextReport, ContextSources, LoadedContext, Ci, CiEntry, CiSummary,
                         #   CiReport, CiState
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
    user.ts              #   fetchAuthenticatedUser(): the login of the token owner (GET /user)
    user-repositories.ts #   listUserRepositories(): the repositories of the token owner (owner,
                         #   collaborator, organization member) by push date, 10 pages of 100 at
                         #   most, without the archived ones; a 403 names metadata:read
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
    errors.ts            #   CommandError: not found, timeout, aborted, output too large
    run-command.ts       #   runCommand(), runCommandBytes(): return the exit code, never interpret it;
                         #   detached children in their own process group, killDetachedChildren();
                         #   childScope(): run() records the detached children started (or
                         #   tracked) inside it through AsyncLocalStorage, kill() stops only
                         #   those, so one run's cancel leaves another run's children, and a
                         #   child started in a killed scope is stopped at once;
                         #   an AbortSignal stops the child (its group) like the timeout
    run-interactive.ts   #   runInteractive(): a command with stdio inherited (the terminal is
                         #   its own), its exit code (128 + n for a signal), not found, ended by
                         #   an AbortSignal; spawn injectable
    work-dirs.ts         #   openWorkDir(), closeWorkDir(), removeOpenWorkDirs() (Ctrl-C),
                         #   sweepOrphanWorkDirs(): the phada-native-* folders
  providers/             # ReviewProvider and its implementations
    types.ts             #   ReviewProvider, ReviewPrompt, ReviewOutput, ProviderError; ProviderStatus
                         #   (CliStatus, OllamaStatus)
    cli-run.ts           #   shared by AI CLIs: temp dir, env without GitHub tokens, typed errors
    redact-secrets.ts    #   redacts token patterns from CLI output in error messages
    claude.ts            #   ClaudeCliProvider: review() and runSkill() (+ claude-model.ts: model
                         #   resolution; claude-skill-args.ts: allowed tools, temporary plugin)
    codex.ts             #   CodexCliProvider (+ codex-model.ts: model resolution; codex-mcp.ts:
                         #   named MCP servers as -c settings; mcp-env-launcher.ts: runs a server
                         #   with the env of a private file)
    ollama.ts            #   OllamaProvider over HTTP (+ ollama-host.ts; node-http-fetch.ts: fetch
                         #   over node:http, the body streamed as it arrives)
    cli-status.ts        #   runStatusCommand(): a status command of an AI CLI (5 s, env without
                         #   GitHub tokens) → its result, missing or a problem; installOf(), loginOf()
    claude-status.ts     #   checkClaudeStatus(): `claude --version` + `claude auth status --json`
                         #   → installed (version), logged in (method) or out; never the account
    codex-status.ts      #   checkCodexStatus(): `codex --version` + `codex login status` → the same
                         #   (chatgpt or api-key, never the key)
    ollama-status.ts     #   checkOllamaStatus(): /api/version + /api/tags at OLLAMA_HOST → running
                         #   (version, models), stopped or a problem
    ollama-pull.ts       #   pullOllamaModel(): POST /api/pull at OLLAMA_HOST, its NDJSON stream →
                         #   progress (status, completed, total) and pulled, cancelled (the
                         #   signal), stopped or failed (Ollama's error line, HTTP status)
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
                         #   outdated › oldest left out first) and the report;
                         #   conversationItemBytes()
    plan-publication.ts  #   planPublication(): new comments vs findings still open in a thread vs
                         #   findings whose thread a person resolved vs findings of a thread found
                         #   fixed in this run
    types.ts             #   PublicationPlan, RunDecision, SkipReason, Conversation(Report)
  repository/            # the repository through git objects, in a persistent mirror
    checkout.ts          #   Checkout (read, grep, list, history), CheckoutError
    git-checkout.ts      #   GitCheckout: one commit of the mirror (log, blame); the git environment
                         #   without tokens
    git-mirror.ts        #   openGitMirror(): bare repository in the cache, fetch --depth 1 into
                         #   refs/phada/* (stopped by the caller's signal), deepen to 200 commits for history, ls-tree -r,
                         #   cat-file --batch; openExistingGitMirror(): only the local reads
                         #   (ls-tree, cat-file) of a mirror that already exists, missing as a
                         #   state, never creating or fetching one
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
    index-store.ts       #   openIndexStore(): blobs, commits, summary, prune, reader();
                         #   openExistingIndexStore(): read-only — missing, other version (found
                         #   and expected), unreadable or open (the latest snapshot of the
                         #   default branch, else the latest; summary, files left out, reader),
                         #   never creating, migrating or removing the file; RELATED_REF
    index-reader.ts      #   IndexReader: the files, symbols, calls and uses of one commit
    observed-store.ts    #   openObservedStore(): relations learned from reviews (own schema);
                         #   readObservedEdges(): read only, missing or unreadable as data,
                         #   never creating or rebuilding the file
    history-store.ts     #   openHistoryStore(): the review history, never rebuilt; watched
                         #   repositories and pull requests, jobs and their review requests, runs
                         #   with their verdict, pause, runs() (with the title, by text), run(),
                         #   prune(); requestsWith(): the requests of a source whose data has
                         #   some values (a Slack message);
                         #   readOnly: no folder, pragma or migration, an older file refused
                         #   (HistoryOutdatedError); openExistingHistoryStore(): missing, open,
                         #   newer, older or unreadable as data, never creating the file
    history-feedback.ts  #   published findings, observations and their signals (observed and
                         #   cleared), feedbackDue()
    history-columns.ts   #   the history tables (columns, keys) and their insert/upsert/update
    history-migrations.ts #  versioned migrations (PRAGMA user_version), a table rebuilt with the
                         #   foreign keys off; a newer file is refused
  watch/                 # pure: what the watch does, data in, decision out
    filters.ts           #   eligibility(): draft, bot, outside author, authors, labels, base
    plan-cycle.ts        #   planCycle(): baseline, seen, enqueue, supersede, move (the requests
                         #   of a ci-failing job to a new commit), gone
    next-job.ts          #   pickNext(): the next ready job, queued or waiting for CI, or until
                         #   when to wait (pause, limit); NOT_STARTED, notStarted()
    ci-gate.ts           #   ciGate(): CI state, ci.wait, onFailure, when Phada saw the commit and
                         #   now → review (with the checks still pending), wait (until, deadline;
                         #   also while a check fails and others run, unless onFailure: skip)
                         #   or skip; 2 min for checks to appear, read again each minute;
                         #   CI_PENDING, CiGateSummary
    ci-revisit.ts        #   ciRevisits(): the ci-failing jobs to read again (24 h, head still
                         #   the pull request's, eligible or asked by a request other than the
                         #   watch, 10 per cycle, read longest ago first); revisitsCi(),
                         #   skippedForCi(), requeueForCi(), CI_FAILING
    failures.ts          #   afterFailure(): retries, pauses, failed, stop; rateLimitPause()
    request-policy.ts    #   decideRequest(): closed, outside author, join, already reviewed, ask the
                         #   when command, hourly limit; a ci-failing job joined and queued
                         #   again; publishOf()
    pull-facts.ts        #   PullFacts of a listed or fetched pull request
    pr-commands.ts       #   prCommands(): /phada review comments → requests, and the cursor
    time.ts              #   later(): an ISO time plus a duration
    types.ts             #   JobRecord (ciDeadline, ciPending, ciFailing, ciCheckedAt, ciSince),
                         #   RequestRecord, RequestSource,
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
test/fixtures/bin/       # fake AI CLIs used by the provider and status tests
test/fixtures/github/    # trimmed GitHub API responses (REST and GraphQL) and a synthetic diff
test/support/            # shared test helpers (fake fetch, fixtures for pull requests, findings, …;
                         #   tui.tsx: the app rendered with fake deps, size, scheduler and keys;
                         #   showing() and until() fail with what they awaited and the last
                         #   frame when it does not come)
```

Tests live next to the code they test (`*.test.ts`, `*.test.tsx` for the app's frames with
`ink-testing-library`).
