# Changelog

All notable changes to Phada are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Phada uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While Phada is in `0.x`, options and
output can change between minor versions.

## Unreleased

## 0.9.0 - 2026-10-25

### Added

- The review and the verifier get the conversation of the pull request: its general comments,
  reviews and review threads with their replies and the role of each author, without Phada's own
  comments, as untrusted data within 16 KB (each body cut at 2 KB). The AI does not raise again
  what a thread still open already raised or a reply dismissed, weighs what the author explains,
  and reports instructions aimed at reviewers or AI tools. `conversation: false` or
  `--no-conversation` turns it off.
- The review and the verifier get the checks of the head: check runs and commit statuses, and for
  each failing one its title, summary, annotations (50 in total) and the end of the failed step of
  its GitHub Actions log (12 KB in total), as untrusted data. A failure caused by the diff becomes
  a finding that cites the check; failures unrelated to the diff and pending checks are not
  reported. `ci.checks` picks the checks that count; `ci.read: false` or `--no-ci` turns them off.
- A CI line under the score of the published review (`CI: 2 of 7 checks failing (test, lint)`),
  and `Conversation:` and `CI:` lines in the terminal.
- `--dry-run` sections and `conversation` and `ci` blocks in the JSON with what was sent, left
  out and cut, and the warnings.
- `phada watch` waits for the pending checks of a commit before reviewing it, for at most
  `ci.wait` (default `15m`, `0s` turns it off), and lists the jobs waiting for CI in
  `phada watch --status`.
- `ci.onFailure: skip` makes the watch skip a commit whose checks fail (`ci-failing`), read them
  again for 24 hours and review it once they pass; a request for that commit reads them again at
  once. Slack answers with the failing checks.
- `phada review --wait-ci` waits for the pending checks of the head within `ci.wait`, with a live
  counter, and then reviews.
- `ci` in the review events, with the CI state and the checks that count.
- A native skill finds the conversation, the checks and the impact of the change in
  `.git/conversation.jsonl`, `.git/ci.md` and `.git/impact.md`, and `gh pr checks` answers from
  the checks Phada read.
- `phada prompt` shows the conversation and CI blocks with their sizes.
- A token without the permission to read check runs, commit statuses or job logs gets a warning
  that names it, and the review goes on without that part.

### Changed

- A fine-grained token needs **Checks**, **Commit statuses** and **Actions** read access for the
  review to get the CI checks; a classic token with `repo` already has it.
- When a prompt with the conversation or the checks does not fit an Ollama model, the error
  suggests `--no-conversation` or `--no-ci`.
- The history moves to version 4; older Phada versions refuse the updated file.

## 0.8.0 - 2026-10-24

### Added

- `phada enqueue owner/repo#N` asks the watch for a review (`--publish pr|none`,
  `--format json`), and exits with 1 when the request is refused.
- `phada mcp`, an MCP server over stdio, lets your AI ask for a review (`review_pull_request`),
  follow it (`job_status`, `list_queue`) and wait for its verdict and full review
  (`wait_for_job`).
- `/phada review` commented by an owner, member or collaborator of a watched repository queues a
  review of that pull request; the watch reacts with 👀.
- Slack: with `slack:` in your own config and `PHADA_SLACK_BOT_TOKEN` and
  `PHADA_SLACK_APP_TOKEN` in the environment, `phada watch` reviews the pull requests linked in
  the channels you list, marks the message with ⏳ and then the emoji of the verdict, and answers
  in its thread with a link, a summary or every finding (`reply`), publishing on the pull request
  or not (`publish`) per channel.
- `hooks:` runs a command of yours on `review.started`, `review.finished` (with the full review),
  `review.failed` and `review.skipped`, with the event as JSON on stdin.
- `watch.when` (and `when` per repository) runs a command that decides, from the pull request and
  the request on stdin, whether a request or a push gets a new review; a request that joins a
  queued job or a commit already reviewed does not ask it.
- A verdict computed by Phada (`clean`, `comments`, `blocking`, `failed`, `skipped`) in the JSON
  of every review, in the events and in the history.
- `phada watch --status` shows who asked for each job, and `phada history` who asked for each
  review of the watch.
- A request for a commit Phada already reviewed on the pull request gets the link of that review,
  in the `review.skipped` event and in the Slack reply.
- MCP servers declared in your own config, for Claude Code, Codex and Ollama alike: started by
  Phada (`command`, `args`, `env`) or reached over streamable HTTP (`url`, `headers`). Their
  tools are offered to the AI next to the investigation tools, in the same budget of calls and
  bytes, and each call shows up in `--dry-run` and the JSON with its server.
- Codex servers can be named in `mcp`, like Claude Code ones: Phada reads them with
  `codex mcp get` and passes them to the run without putting header or environment values on the
  command line.
- `tools` narrows a server to the tools listed, and `description` tells the AI what a server is
  for.
- Secrets of a declared server come from environment variables (`${NAME}`); a value that looks
  like a secret written in the config is refused.
- `--dry-run` and the JSON (`investigation.mcp`) list each MCP server with its state and the tools
  it hid.

### Changed

- Every review request, from the polling or from anywhere else, goes through the same checks: a
  watched repository, an open pull request, no outside author on a public repository, the `when`
  command, a commit not reviewed yet and `maxReviewsPerHour`. A request for a commit that already
  has a job joins it.
- A request is reviewed without the settle time, and also when the pull request is a draft or
  does not match the filters of `watch:`, which now only decide what the polling picks up.
- When a command run by Phada with its own process group runs out of time, the whole group is
  stopped, not only its first process.
- The history moves to version 3; older Phada versions refuse the updated file.
- Pull requests of public repositories from outside authors are reviewed without any of your MCP
  servers.
- A declared server offers only the tools it marks as read-only unless `tools` lists others.
- MCP server names are checked with your AI CLI before the review; an unknown name, or a name
  with Ollama, stops the command.

## 0.7.0 - 2026-10-22

### Added

- With Claude Code, the skills in `review.skills` (other than `phada`) run natively as
  `/<name>` in a temporary checkout of the pull request head, with the base as `origin/<base>`,
  read tools, subagents, Phada's investigation tools and the MCP servers in `mcp`. What the skill
  tried to post, or its final answer, is turned into findings on the diff lines and goes through
  the usual checks, verification and score; when none of its findings points at a changed line,
  its output becomes the body of the review. `--dry-run` and the JSON (`passes[].output`,
  `skillBodies`) show the skill's output.
- `gh` inside a native skill is answered by Phada: pull request reads from Phada's data, other
  reads and searches of the same repository through Phada's token (60 per pass), and `gh pr comment`,
  `gh pr review` and `gh api` posts of comments or reviews kept as the skill's output and never
  sent.
- `review.commands` (`read-only` by default, a list of commands, or `all`), `review.readDirs`
  and `review.timeout` (default `30m`), read only from your own config. Pull requests of public
  repositories from outside authors always run read-only. Each command or read a skill was
  refused is shown on stderr, in `--dry-run` and in the JSON (`passes[].blocked`) with the
  config line that allows it.
- `git` inside a native skill refuses options that could run a program, write a file or read
  outside the checkout.
- In a native skill's checkout, symlinks of the pull request are plain files; `gh api` reads only
  the repository's code and conversations (pulls, issues, commits, contents and the like), never
  its settings, secrets, alerts, webhooks or Actions.
- `{ name, mode: text }` keeps a skill in text mode; `claude:<name>` names a skill built into
  Claude Code. Codex and Ollama keep text mode.
- `phada prompt` shows a native pass: the message, the context Phada adds, the commands and
  folders it may use, and the conversion instructions.
- `review.prompt` in `.phada/config.yml` or your own config changes what the reviewer looks for:
  `append` (the default) adds the text of a file to the built-in focus, `replace` swaps the
  built-in role, scope and list of what not to report. The output format, line numbers,
  confidence and severity scales stay the same.
- `review.skills` (and `--skill`, repeatable) reviews with skills installed for your AI CLI: your
  Claude Code skills and commands, the skills and commands of your Claude Code plugins
  (`plugin:skill`), and Codex and `~/.agents` skills. Each skill runs as its own pass, with its
  text (and the `.md` files it names, up to 32 KB) as the reviewer's guide on every provider, and
  the findings are merged into one review. `phada` is the built-in reviewer; `paths` runs a skill
  only for some files, and nothing is published when no skill applies to the changed files. Every finding names its skill in the JSON (`skill`) and under its comment,
  the JSON has a `passes` block, and `--dry-run` lists each pass with its time and tokens.
- The verifier sees the guide a finding came from, so findings the user's guide asks for are not
  rejected as style.
- `phada prompt owner/repo#N` prints the prompt a review would send, pass by pass, with where
  each part comes from and the size of the data blocks, without calling the AI;
  `phada prompt --default` prints the built-in prompt; `--format json`.

### Changed

- Ctrl-C during `phada review` stops it at once and removes its temporary files.
- Text Phada publishes on a pull request is checked for token patterns, which are replaced by
  `[REDACTED]`.

## 0.6.0 - 2026-10-22

### Added

- The history keeps every comment Phada publishes and what happened to it, read from its thread
  without the AI: fixed (resolved by Phada after a recheck, or by a person after its lines
  changed), dismissed (resolved by a person without a change), ignored (still open when the pull
  request closed) or open, plus a negative reaction (👎 or 😕) and a reply from someone. Each
  signal keeps when it started and when it stopped. `phada review` saves the threads it reads;
  `phada watch` reads the pull requests with Phada comments every 30 minutes when idle and once
  more when they close.
- `phada history [owner/repo[#N]]` lists past reviews (`--since`, `--limit`), the comments of a
  pull request with their outcome, and `--stats` per repository; `--refresh` reads the comments
  on GitHub first; `--format json` with `schemaVersion: 1`. `phada history prune` removes old
  reviews, comments and finished jobs (`--older-than 180d`).
- Durations accept days (`30d`).
- Findings can carry a code suggestion, kept only when it replaces up to 20 lines of one `@@`
  section of the diff that it quotes exactly; the verifier can drop it. It is published as a
  GitHub suggestion that applies with one click, shown as a `diff` block in the terminal, and
  listed in the JSON (`suggestion`, `suggestions`).
- On a new commit, Phada rechecks its own open comments from earlier commits with one AI call,
  using what changed in each file since the comment. Comments found fixed get a reply naming the
  commit and are resolved before the new review is posted; still valid or unsure ones stay open.
  A finding of a comment Phada resolved comes back if the problem returns; one a person resolved
  never does. `resolveThreads: false` or `--no-resolve` turns it off; the JSON has a `recheck`
  block and `resolved` counts.
- A new commit whose filtered diff has the same fingerprint as the last Phada review is skipped
  without calling the AI (`same-diff`), including pushes that only touch ignored files and base
  branch merges that only move lines.

## 0.5.0 - 2026-10-18

### Added

- `phada watch` follows the repositories listed under `watch:` in your own config and reviews
  new pull requests and new pushes on its own, one at a time, after a settle time (`interval`,
  `settle`, `maxReviewsPerHour`; per repository `publish`, `allowExternal`, `authors`, `labels`,
  `baseBranches`). Pull requests already open are recorded, not reviewed, unless `--backfill`.
  Drafts, bots and outside authors on public repositories are left out.
- The watch keeps one job per pull request (the newest commit wins), retries transient failures
  twice, pauses on a provider usage limit or the GitHub rate limit, stops when the AI CLI is not
  logged in, never publishes a review of a commit the pull request moved away from, and updates
  the index of each default branch when idle. `--once` runs one cycle for cron; `--status`
  (`--format json`) shows the queue, failures and last reviews; the first Ctrl-C lets the running
  review finish. The watch does not start when the provider set for a watched repository cannot
  work (ollama without a model, `mcp` with a provider other than Claude).
- A local history in `~/.local/share/phada/history.sqlite` (`PHADA_DATA_HOME`) keeps every
  review, from the watch and from `phada review`, with its JSON and without the diff;
  `history: false` turns it off.
- Reviews read the instruction files a repository keeps for other AI tools as reference docs:
  `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`,
  `.cursor/rules/*.mdc`, `.cursorrules`, `.windsurfrules` and `GEMINI.md` at the root, and
  `GEMINI.md` and `.cursor/rules/*.mdc` in the folders of the changed files.
- Instruction files that say where they apply are sent only when a changed file matches
  (`applyTo`, `globs`); `alwaysApply: true` always applies; files meant to be attached by hand, or
  with `excludeAgent: code-review`, are left out.
- `phada rules owner/repo#N` shows the context the review of a pull request gets, and
  `phada rules owner/repo` lists the rules, docs and ignore patterns on the default branch,
  without calling the AI; `--format json` for scripts.

### Changed

- A finding with the same title as a Phada thread someone resolved in that file is no longer
  posted again on the next review of that pull request; stderr and the JSON publication (`dismissed`) count them. The JSON
  keeps `schemaVersion: 1`.
- The context report (`--dry-run` and the `context` block of the JSON) shows the scope and
  severity of each rule, the scope of each instruction file and why one was left out
  (`out-of-scope`, `manual`, `excluded`). The JSON keeps `schemaVersion: 1` and only gains fields.
- The `Context:` line counts the instruction files that did not apply as "not applied", apart from
  the docs omitted for the budget or a failed read.

## 0.4.0 - 2026-10-17

### Added

- Related repositories: `context.repos` in the root `.phada/config.yml` or in your own config
  lists other repositories a review may read (`owner/repo`, or `{ repo, description }`). Phada
  fetches the head of their default branch and the AI reads them with the new `repo` argument of
  `read_file`, `grep`, `list`, `find_symbol`, `callers`, `dependencies` and `similar`; up to 7 are
  read per review.
- When a package manifest links the two repositories (npm, Go modules, Python), the related
  repository is indexed and the impact of the diff follows the changed symbols to the code that
  calls them there; `dependencies` points to the definitions in a package the reviewed repository
  uses. Sources can cite `owner/repo:path`.
- A private related repository is never read for a public pull request unless your own config
  sets `context.privateOnPublic: true`; the related repository's `.phada/` is never loaded.
- `Related: …` on stderr, a `Related repositories` section in `--dry-run` and a `related` block in
  the JSON.

## 0.3.0 - 2026-10-15

### Added

- Reviews use a graph of the repository's code. Before the AI starts, Phada indexes the pull
  request head (only the files it has not read before, for at most 60 seconds), resolves names to
  their definitions (relative imports, `tsconfig` paths, packages of the same repository, Python
  packages, Go modules) and sends
  the impact of the diff: the symbols it changes, the code that calls or uses them, with each
  line, and what they depend on. `Impact: 3 changed symbols · 12 callers in 7 files` on stderr, an
  `Impact` section in `--dry-run` and an `impact` block in the JSON.
- New tools for the AI: `find_symbol`, `callers`, `dependencies`, `similar` (functions built like
  a given one) and `history` (the commits and pull requests that changed a file or lines).
- Phada learns from reviews: a confirmed finding that relied on a file the AI read, with no link
  in the graph, becomes an observed relation shown in later reviews of the repository.
- The map records uses of imported names that are not calls (callbacks, constants, types);
  `phada index` counts them as `uses`.
- `phada index <owner/repo>` builds a map of the repository's code on your machine: files,
  functions, classes, methods, parameters, variables, imports, exports and calls for TypeScript,
  JavaScript, Python and Go, parsed with tree-sitter. Running it again reads only the files that
  changed. `--ref` picks a branch, tag or commit and `--format json` prints the report as JSON,
  with every file left out and why. Dependency folders committed to the repository
  (`node_modules`, `vendor`, …) stay out of the map. A new version of Phada builds the map again from scratch.

### Changed

- Reviews keep a mirror of each repository in `~/.cache/phada` (`PHADA_CACHE_HOME` to move it)
  and fetch only what changed since the last review, instead of a temporary folder each time.
- Phada needs Node.js 22.13 or newer.

## 0.2.0 - 2026-10-10

### Added

- Reviews now use the repository's own rules and docs, read from the base commit of the pull
  request: `.phada/config.yml` and `.phada/rules.md` (at the root and in subfolders), and docs
  such as `AGENTS.md`, `CLAUDE.md`, `.claude/rules/`, `CONTRIBUTING.md`, `README.md` and `docs/`,
  within a 60 KB budget that never cuts silently.
- Your own config in `~/.config/phada/` (global, or per repository in `repos/<owner>/<repo>/`)
  sets the provider, model, review options, rules and local docs.
- `phada init` creates the repository config; `phada init --global [owner/repo]` creates yours.
- Lockfiles, minified files and source maps are left out of the diff, and the review names them
  (a pull request with only ignored files gets a short note); `ignore` adds more.
- Findings name the rule they break and the sources they rely on, in the JSON and on the pull
  request; the JSON has a `context` block with everything sent to the AI.
- `--no-verify` turns verification off when the config turns it on.
- The AI investigates the repository while it reviews: Phada fetches the head commit and gives
  the AI read-only tools (`read_file`, `grep`, `list`) that only see that commit, with a budget
  per pass. The verifier uses them too. `--no-investigate` or `investigate: false` turn it off;
  without `git` the review runs as before and warns.
- An `Investigated:` line, an `investigation` block in the JSON and an Investigation section in
  the `--dry-run` preview list what the AI read; findings cite the files they rely on.
- `mcp` in your own config lets Claude Code use the MCP servers you name during the review, with
  a warning on public repositories.

### Changed

- Releases go through the npm stage and wait for a maintainer's approval.
- Claude Code and Codex get 15 minutes per call instead of 10, since the investigation adds turns.
- Findings are verified by default: a second call to the AI checks every finding before scoring.
  `--no-verify` or `verify: false` turn it off.

## 0.1.0 - 2026-10-08

First public release.

### Added

- `phada review <owner/repo#N | pull request URL>` reviews a GitHub pull request with an AI
  provider you already use: Claude Code (`claude`, the default), Codex (`codex`) or a model
  served by Ollama (`ollama`), chosen with `--provider` and `--model`.
- The review has a score from 0 to 5 computed by Phada, a summary, the changed files and findings
  grouped by severity (P0, P1, P2), each with its file, line, confidence, why it matters and a
  suggested fix. Findings always point to a line inside the diff.
- `--min-confidence <n>` sets the confidence cut (50 to 100, default 60); findings below it are
  listed as worth checking.
- `--verify` checks every finding with a second call to the AI before scoring.
- `--format json` prints the review as data (`schemaVersion: 1`).
- `--language <tag>` sets the language of the review; Phada's own labels are in English and
  Portuguese.
- Phada publishes the review on the pull request as the owner of the GitHub token: one comment on
  the line of each finding and the rest in the review body. It skips a commit it already reviewed
  while its threads are open, and does not post again a finding that matches an open thread.
- `--dry-run` prints exactly what would be published and posts nothing; `--force` reviews and
  publishes even when Phada already reviewed the commit.
- The GitHub token is read from `GITHUB_TOKEN` or `GH_TOKEN`.
