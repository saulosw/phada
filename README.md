# Phada

> **Phada publishes by default.** `phada review` posts the review on the pull request as the
> owner of the GitHub token. Use `--dry-run` to only print it.

Phada reviews a GitHub pull request with the AI you already use — Claude Code, Codex or a model
served by Ollama — and publishes the review on the pull request.

It runs on your machine. Phada fetches the pull request and its diff, reads the repository's
own rules and docs, sends them to the AI provider you choose, lets the AI read the rest of the
repository with read-only tools, checks that the answer is a valid review and scores it. It prints the review
as Markdown or JSON and posts it on the pull request: one comment on the line of each finding and
the rest in the review body (see [Publishing](#publishing)).

## Requirements

- Node.js 22.13 or newer
- `git`, for the repository investigation and `phada index` (without it, the AI only sees the diff and the context)
- A GitHub token that can read the pull request and write reviews (see [GitHub token](#github-token))
- One AI provider:
  - [Claude Code](https://code.claude.com/) (`claude`), logged in with your subscription,
  - [Codex CLI](https://developers.openai.com/codex/cli) (`codex`, install with `npm i -g @openai/codex`, then `codex login`), or
  - [Ollama](https://ollama.com/download), running, with a model pulled (e.g. `ollama pull qwen2.5-coder:7b`)

## Install

```bash
npm install -g phada
phada --version
```

Or run it without installing:

```bash
npx phada review owner/repo#123
```

## Usage

```bash
export GITHUB_TOKEN=$(gh auth token)
phada review owner/repo#123
phada review https://github.com/owner/repo/pull/123 --provider codex
```

Progress goes to stderr and the review to stdout, so `phada review owner/repo#123 > review.md`
saves only the review, and `--format json` prints it as JSON for scripts. A review of a large pull
request can take a few minutes. `phada review owner/repo#123 --dry-run` prints exactly what would
be posted and posts nothing.

`phada --help` lists the commands, and `phada review --help`, `phada init --help`,
`phada index --help`, `phada rules --help` and `phada watch --help` list their options. To have
new pull requests and pushes reviewed without running anything, see [Watch mode](#watch-mode).

### GitHub token

Phada reads the token from `GITHUB_TOKEN`, or from `GH_TOKEN` when `GITHUB_TOKEN` is not set. It
reads the pull request and its reviews and publishes a review, so the token needs:

- a fine-grained token with **Contents: Read-only** and **Pull requests: Read and write** on the
  repository, or
- a classic token with the `repo` scope (`public_repo` is enough for public repositories).

A read-only token is enough with `--dry-run`. Without write access, Phada still prints the review
and then stops with an error that names the missing permission. **Contents: Read-only** lets
Phada read the repository's rules and docs (see [Rules and repository context](#rules-and-repository-context));
without it, the review runs on the diff alone and says so.

If you use the GitHub CLI, `export GITHUB_TOKEN=$(gh auth token)` reuses its login (older `gh`
versions without `gh auth token` show it with `gh auth status -t`).

## What a review looks like

Phada sends the diff with the line number of every added and context line, so the AI copies
the line instead of counting it. The AI answers in a fixed JSON shape that Phada validates, and
every finding must point to a file of the pull request and a line inside the diff. Phada then
prints:

- **Confidence score (0–5)**, computed by Phada from the findings, never by the AI: 5 means no
  problems found, 4 only P2 findings, 3 one P1, 2 two or more P1, 1 one P0, 0 two or more P0.
  Neither the AI nor text inside the pull request can set the score directly; it only follows
  the findings.
- **Summary** of what the pull request changes and a **table of the changed files**.
- **Findings grouped by severity**, each with file, line, confidence (0–100), why it matters and
  a suggested fix (with the exact code change when the fix is a local edit, see
  [Suggested changes](#suggested-changes)). Confidence is how sure the AI is that the problem is real and happens as
  described; how often it happens and how much it costs go into the severity, so a real but rare
  bug is a sure finding with a lower severity (a P0 stays P0 however rarely it happens). Only
  findings at the confidence cut or above are shown here (60 by default, see `--min-confidence`):
  - **P0 · Must fix**: security holes, data loss, crashes, wrong money handling;
  - **P1 · Should fix**: bugs, incorrect behavior, edge cases, race conditions, leaks;
  - **P2 · Consider**: maintainability or design risks with a concrete consequence.
- **Worth checking**: up to five findings with confidence from 50 up to the cut, one line each.
  They do not change the score.
- A footer with how many findings there are, how many are worth checking, how many were dropped
  (rejected by verification, outside the diff, duplicates, below confidence 50, or not in the
  expected shape) and the provider, model, time and tokens.

By default (turn it off with `--no-verify` or `verify: false`), the first pass asks the AI for every
candidate from confidence 25 instead of 50, and Phada makes a second call to the same AI before
scoring. It sends the pull request, the diff and the candidates, without their severity and
confidence, and asks a skeptical reviewer to confirm each one, with its own severity and confidence,
or reject it. Rejected findings leave the review and are counted in the footer; `--format json`
lists them with the reason, and gives the verifier's reason for every confirmed finding too (`null`
for a finding it did not check). Confirmed findings still below 50 are dropped like any other. A
finding without an answer keeps its first rating and the footer says how many were left unchecked
(`not verified` when none got an answer). Verification adds about half the time and doubles the
tokens; the time and tokens shown are the total of both calls.

If the AI's answer is not a valid review, Phada stops with an error instead of printing it;
`--debug` shows the start of the answer.

### Suggested changes

When the fix of a finding is a local edit, the AI also gives the lines it replaces and the code
that takes their place. Phada keeps that suggestion only when the lines are added or context
lines of one `@@` section of the diff, at most 20 of them, include the line of the finding, are
quoted exactly as they are in the diff, and the new code differs from them and holds no hidden
control or bidirectional characters. Otherwise the finding keeps only its fix in words. The
verifier sees the suggestion too and drops it when the new code would not fix the problem or
would break something else. A kept suggestion shows as a `diff` block in the terminal and is
published as a GitHub suggestion that the author applies with one click (`suggestion` in the
JSON, and a `suggestions` count of valid, invalid and dropped ones).

## Publishing

Each run posts one GitHub review (a comment review, never an approval or a request for changes)
on the commit it reviewed, as the owner of the token:

- every finding becomes a comment on its line, with severity, title, confidence, why it matters
  and the suggested fix;
- the review body has the score, the summary, the changed files, how many findings were posted,
  the findings worth checking, what was dropped and the provider and model;
- a pull request without changes gets nothing.

Phada reads its earlier reviews and threads on the pull request first, and only counts the ones
written by the owner of the token. It decides before calling the AI:

| Earlier Phada review on the same commit                | What happens                                             |
| ------------------------------------------------------ | -------------------------------------------------------- |
| None                                                   | Reviews and publishes                                    |
| Exists, and a Phada thread on the pull request is open | Skips: "already reviewed by Phada; N threads still open" |
| Exists, it had findings and every thread is resolved   | Reviews and publishes again (see below)                  |
| Exists and found nothing                               | Skips: "already reviewed by Phada; nothing was found"    |

`--force` always reviews; `--dry-run` never skips and says what a real run would do. A skipped run
exits with 0 and does not call the AI.

After a new push, a finding that matches an open Phada thread (same file, and the same title or a
line within three of it) is not posted again as a comment: the review body lists it under "Still
open from previous reviews", so it never disappears from the pull request. When every finding is
still open, Phada posts only a short note saying there is nothing new and how many findings remain
open. A finding with the same title as a Phada thread someone resolved in that file is not posted
again either (a different finding near it still is): the run says how many findings were
dismissed earlier and left out (`dismissed` in the JSON).

### Comments fixed in a new commit

On a new commit, Phada first rechecks its own open comments from earlier commits, one AI call
for all of them. For each comment it sends what changed in that file since the comment was
posted (GitHub's comparison of the two commits) and lets the AI read the file at the new head;
a comment whose file did not change stays open without asking the AI. The AI answers `fixed`,
`still-valid` or `unsure` for each one, and Phada only acts on `fixed`: right before posting the
new review, it replies on the thread "Fixed in `abc1234`: …" with the reason and resolves it. A
comment that is still valid or unsure stays open, Phada never reopens a thread, never touches
threads of other people, and a failure on one thread does not stop the others (the run says
"Resolved N of M comments found fixed"). The new review does not post again a finding of a
comment found fixed in the same run; if the problem comes back in a later commit, it is posted
again, while a finding whose thread a person resolved is never posted again. `--dry-run` says
what it would resolve and resolves nothing, and nothing is resolved when publishing is off.
Turn it off with `resolveThreads: false` in a config file or `--no-resolve`. The JSON has a
`recheck` block with every verdict and `resolved` counts in the `publication` block.

### Pushes that change nothing to review

Every review keeps a fingerprint of the reviewed diff, without the files left out of the review,
hunk positions or context lines. A new commit whose diff has the same fingerprint as the last
Phada review of the pull request is skipped without calling the AI: a push that only touches
ignored files, or a merge of the base branch that only moves the changed lines, does not trigger
a new review. `--force` reviews anyway and `--dry-run` says it would skip.

Text written by the AI cannot mention anyone, link other issues or pull requests (`#12`, `owner/repo#12`), add HTML or forge Phada's own markers, and a body
longer than GitHub allows is shortened with a visible "(truncated)". Two runs on the same pull
request at the same time can both publish. GitHub refuses a new review while you have a pending
review of your own open in its interface; submit or discard it first.

## Watch mode

`phada watch` follows the repositories you list in your own config and reviews new pull
requests and new pushes on its own, one at a time, and publishes them like `phada review`:

```yaml
# ~/.config/phada/config.yml
watch:
  interval: 5m # how often to look for changes (60s at least)
  settle: 3m # wait after the last push before reviewing
  maxReviewsPerHour: 6
  repos:
    - owner/repo
    - repo: owner/other
      publish: false # keep the review in the history only
      allowExternal: true
      authors: [alice] # only these authors
      labels: [phada] # only pull requests with one of these labels
      baseBranches: [main]
```

```bash
phada watch              # in the foreground; Ctrl-C once lets the running review finish
phada watch --once       # one cycle and exit, e.g. from cron (always looks for changes)
phada watch --status     # the queue, reviews in progress, failures, last review per repository
```

- `watch` is only read from your top-level config, never from a repository's `.phada/` or from
  `repos/<owner>/<repo>/config.yml`: a repository cannot make your machine review anything. The
  provider, model, language and the other options of each repository come from the usual
  config files, as with `phada review`.
- The first time the watch sees a repository, the pull requests already open are recorded as
  they are and not reviewed; a new pull request, or a new push on any of them, is.
  `--backfill` reviews the open ones too; on a repository the watch already recorded it has no
  effect, and the watch says so.
- A push is reviewed once the `settle` time has passed since the watch first saw it, so a burst
  of pushes leads to one review of the newest commit. There is one job per pull request and one
  review at a time, at most `maxReviewsPerHour` an hour. When a pull request moves to a newer
  commit while it is being reviewed, the review is kept in the history and not published, and
  the newer commit is reviewed instead. A commit Phada already reviewed is never reviewed again.
- Drafts and pull requests opened by bots are never reviewed. On a public repository, only
  pull requests of owners, members and collaborators are, unless the repository sets
  `allowExternal: true`: the AI runs on that code with nobody watching.
- A failure that may pass (network, GitHub 5xx, a provider error) is tried again after 1 minute
  and after 5 minutes; after the third attempt the job is marked failed until a new commit. A
  provider usage limit pauses the queue for 15 minutes (doubling up to 2 hours while it lasts),
  and the GitHub rate limit pauses it until it resets. When the AI CLI is not installed or not
  logged in, or GitHub rejects the token, the watch stops with the error. Nothing is published
  from a review that did not finish.
- With nothing to review, the watch updates the mirror and the [map](#repository-map) of each
  default branch when it moved, a minute at a time, so reviews start from a warm index.
- One watch runs at a time on a machine (a lock in the data folder). The first Ctrl-C lets the
  running review finish and stops; the second stops the AI too and puts the pull request back in
  the queue. To keep it running, start it in tmux or as a service of your own.

`phada watch --status --format json` prints the same as JSON (`schemaVersion: 1`).

## History

Every review is saved on your machine in `~/.local/share/phada/history.sqlite`
(`$XDG_DATA_HOME/phada` when set; `PHADA_DATA_HOME` to choose another folder): the reviews of the
watch, its queue and failures, and every `phada review`, including `--dry-run` and skipped runs.
Each run keeps the same JSON as `--format json`, without the diff; findings can still quote code,
so the file stays readable only by you. Unlike the cache, the history is never rebuilt or deleted
by Phada; a newer version updates it in place, and an older one refuses a file written by a newer
one instead of touching it. `history: false` in your own config turns it off (`phada watch`
needs it).

## Rules and repository context

Besides the diff, every review gets context from the repository and from your own config. All
of it is read from the **base commit** of the pull request, so a pull request cannot change the
rules that review it.

- **Rules** from `.phada/` in the repository and from your own config (see
  [Configuration](#configuration)). They reach the AI as instructions: a change that breaks one
  is a finding that names the rule, and a rule can set the lowest severity of those findings.
- **Docs** the AI reads as reference, in this order: the files your config lists; `README.md`,
  `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `.cursor/rules/*.mdc` in the folders of the changed
  files and above them; at the root, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`,
  `.claude/rules/`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`,
  `.cursor/rules/*.mdc`, `.cursorrules`, `.windsurfrules` and `GEMINI.md`; `CONTRIBUTING.md` and
  `README.md`; then the other Markdown files at the root and in `docs/` (changelogs, licenses and
  codes of conduct are left out). Docs share a 60 KB budget; a doc over 20 KB is cut at a line
  with a visible note, and what does not fit is left out. Nothing is cut or left out silently.
- **Instruction files with a scope**: a `.instructions.md` file is sent only when a changed file
  matches its `applyTo`, and left out without one or with `excludeAgent: code-review`. A `.mdc`
  file is sent when it has `alwaysApply: true`, when a changed file matches its `globs`, or when
  it only has a `description`; one with none of these is meant to be attached by hand and is left
  out. A pattern without a `/` (`*.ts`) matches in any folder, a pattern starting with `!` excludes
  files, and the `globs` of a `.mdc` file in a subfolder's `.cursor/rules/` are relative to that
  subfolder. Files your config lists are always sent.
- **Ignored files**: lockfiles, minified files and source maps never reach the AI; `ignore` in
  the config adds more patterns. The review names every file it left out, so a change hidden in one of them is still visible to whoever reads it; when every changed file is ignored, Phada posts a short note that names them instead of a review.

Phada prints what it sent before the review, e.g.
`Context: 2 rules · 5 docs (21.3 KB, 1 omitted, 2 not applied) · 1 file ignored`, where
"omitted" means a doc did not fit or could not be read and "not applied" means an instruction file
did not apply to this change. With `--dry-run` the preview
ends with the full list, and the JSON has a `context` block with every rule, doc and ignored file,
where it came from, its scope and whether it was sent (`out-of-scope`, `manual` or `excluded`
when an instruction file did not apply). Findings list the docs and files they rely on and the
rule they break, in the JSON and under each comment on the pull request.

### See the context without a review

`phada rules` shows what a review reads besides the diff, without calling the AI:

```bash
phada rules owner/repo#123   # the context the review of this pull request gets
phada rules owner/repo       # everything on the default branch, scopes not checked
```

For a pull request it lists the config files, the rules with their origin, scope and whether they
apply, the docs and why each one was sent or left out, and the ignored files. For a repository it
lists every `.phada/` folder, the rules, the docs a review could read (in subfolders, only where
there is an `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or `.cursor/rules/`) with the scope of each
instruction file, and the ignore patterns. `--format json` prints the same with `schemaVersion: 1`
and the `context` block of `phada review --format json`. It needs a token that can read the
repository contents and never writes anything.

## Repository investigation

The AI can also read the rest of the repository while it reviews: who calls a function the
pull request changes, what a function it uses does, what the rest of a changed file does. Phada
fetches the head commit of the pull request into a local mirror of the repository (`git fetch
--depth 1`, with the GitHub token only in the environment of `git`; see [Cache](#cache)) and
gives the AI tools of its own:

- `read_file`: up to 400 lines of a file per call, with line numbers;
- `grep`: a regular expression over the repository, up to 100 matching lines;
- `list`: the entries of a folder;
- `history`: the last 10 commits that changed a file, or who last changed some of its lines, with
  the pull request each commit came from (read from `(#123)` or `Merge pull request #123` in the
  commit message). The first call of a review deepens the mirror to the last 200 commits;
- `find_symbol`, `callers`, `dependencies` and `similar`: queries of the
  [repository graph](#repository-graph).

The tools only read that commit: no path outside the repository, no symbolic link, no binary or file
over 1 MB. Each review pass gets up to 40 calls and 512 KB of results; the verifier investigates
too, with its own budget. What the tools return comes from the pull request head, written by its
author, so it is data for the AI, never instructions. Findings still point to a line of the diff,
and the files the AI read to support them show up in their sources. The mirror stays for the
next review of the repository, which then fetches only what changed.

Claude Code and Codex reach the tools through a local MCP server that Phada runs for the review;
their own tools stay off. Ollama models use tool calling; a model that does not support it
reviews without the investigation, with a warning.

After the review Phada prints what the AI read, e.g. `Investigated: 6 reads, 3 searches (41.2 KB)`.
With `--dry-run` the preview lists every call, and the JSON has an `investigation` block with
each call, its size and whether a finding used it. `--no-investigate` (or `investigate: false`)
reviews the diff and the context only. Without `git`, or when the head cannot be fetched, the
review runs without the investigation and says why.

### Repository graph

Before the AI starts, Phada builds the [map](#repository-map) of the pull request head (only the
files it has not read before), resolves names to their definitions and works out the **impact of
the diff**: the functions, classes and types the pull request changes, the code that calls or uses
them and what they depend on. The AI gets that list, with the text of each calling line, as the
starting point of its investigation (only when a changed symbol has callers outside the diff; up to 4 KB, 20 changed symbols and 3 lines per file), and
Phada prints a summary:

```text
Impact: 3 changed symbols · 12 callers in 7 files
```

Names are resolved through relative imports, `tsconfig`/`jsconfig` `paths` and `baseUrl`, packages
of the same repository (by the `name`, `exports` and `main` of their `package.json`), Python
packages (relative imports, `src/` layouts, folders with a `pyproject.toml`, `setup.py` or
`setup.cfg`) and Go modules (`go.mod`). A method called on an object whose type Phada cannot see
is matched by name when one to three definitions have that name, and marked `inferred`; calls it
cannot resolve count as external. The AI can query the graph itself:

- `find_symbol`: where a function, class, method, type or variable is defined;
- `callers`: the code that calls, uses or inherits from a symbol, with each line;
- `dependencies`: what a symbol calls, uses and inherits, and where each is defined or which
  package it comes from;
- `similar`: functions built like a given one (the same calls, parameters and name), to check that
  a change follows the pattern of its neighbors.

Phada also learns from reviews: when the verification confirms a finding whose sources include a
file the AI read with the tools, and the graph has no link between the changed symbol and that
file, Phada keeps that link as an **observed** relation of the repository (in `observed/` in the
[cache](#cache), on this machine only). Later reviews show it, marked `observed #<pull request>`,
after the static relations, for as long as both ends still exist.

The first index of a large repository can take minutes (about 2 minutes for 20,000 files). A
review waits for it for at most 60 seconds; after that it reviews without the graph, says so, and
the next review (or `phada index owner/repo`) continues where it stopped. `--dry-run` shows the
impact sent to the AI in an `Impact` section, and the JSON has an `impact` block with each changed
symbol, its callers and the relations the review learned. `--no-investigate` turns the graph off
with the rest of the investigation.

### Related repositories

A change in a shared package can break code in another repository. List the repositories a review
may read as context, in the repository's `.phada/config.yml` (read at the base of the pull
request) or in your own config:

```yaml
context:
  repos:
    - acme/web
    - repo: acme/sdk
      description: SDK that wraps this API for the frontends
```

For each one, Phada fetches the head of its default branch into the [cache](#cache) and the AI
can read it with the `repo` argument of `read_file`, `grep`, `list`, `find_symbol`, `callers`,
`dependencies` and `similar` (`history` stays on the reviewed repository). When a package manifest
links the two repositories (`package.json` dependencies and `name`, `go.mod` `require` and
`module`; for Python, the dependencies in `pyproject.toml` (`[project]` or Poetry) or
`requirements*.txt` and the package name in `pyproject.toml`, `setup.py` or `setup.cfg`; the
`install_requires` of `setup.py` and `setup.cfg` are not read), Phada also
indexes the related repository and follows the link: the [impact](#repository-graph) of the diff
lists the code in the other repository that calls what the pull request changes, and
`dependencies` points to the definitions in a package the reviewed repository uses. Findings still
point to a line of the diff; a file of another repository is cited as `owner/repo:path`.

```text
Related: acme/web (consumer, 4 call sites) · acme/sdk (linked) · acme/admin (no link)
```

- Up to 7 related repositories are read per review: first those with code related to the change,
  then those linked by a package, then the rest, in the order they are declared (your config for
  this repository, then the repository's, then your global config). At most 20 are fetched.
- Linked repositories are indexed within 60 seconds in total; one that is not ready is read
  without its graph, and the next review (or `phada index owner/repo`) continues it.
- A private repository is never read for a public pull request, because what the AI reads may end
  up in the published review, unless your own config sets `context.privateOnPublic: true` (the
  repository's `.phada/` cannot).
- The related repository's own `.phada/` is never loaded: only the reviewed repository's rules
  apply, and what the AI reads in a related repository is data, like the pull request head.
- A repository you cannot read, an empty one, or one whose fetch fails is skipped with a warning;
  the review goes on. `--dry-run` shows a `Related repositories` section, and the JSON a `related`
  block with each repository, its commit, its link and why one was skipped.

### Your AI's MCP servers

With Claude Code, your own config can let the AI use some of the MCP servers you set up in Claude
Code, for example to read the ticket a pull request refers to:

```yaml
# ~/.config/phada/config.yml
mcp: [linear, 'claude.ai Linear']
```

Only the servers you name are allowed, and only from your own config (never from the
repository's `.phada/`); claude.ai connectors are named as `claude.ai <Name>`. Calls to them are
counted in the `Investigated:` line and the JSON, and a finding based on one cites it as
`<server>: <what it read>`. On a public repository Phada warns that what the AI read there may end
up in the published review. `mcp` does not work with Codex or Ollama yet.

## Repository map

`phada index owner/repo` builds a map of the repository's code on your machine: its files,
functions, classes, methods, parameters, variables, imports, exports, calls and uses of imported
names, for TypeScript,
JavaScript, Python and Go. It fetches the default branch (or `--ref <branch, tag or full commit SHA>`) into
the local mirror and parses each file with [tree-sitter](https://tree-sitter.github.io/). Files are
kept by their git blob, so running it again reads only the files that changed.

```text
$ phada index owner/repo
Indexed owner/repo at 8ff3f28 (default branch) in 3.7s
Files: 170 indexed (170 read, 0 unchanged) · 27 left out
Languages: TypeScript 170
Symbols: 483 functions · 83 methods · 31 classes · 136 interfaces · 45 types · 1,581 variables · 963 parameters
Imports 1,297 · exports 388 · calls 9,830 · uses 2,104
Left out: 26 no grammar (.json 11, .md 6, (none) 5, other 4) · 1 ignored
Index: ~/.cache/phada/index/owner/repo.sqlite (2.4 MB) · mirror 301.2 KB
```

Files in other languages, binary files, files over 1 MB, symbolic links, submodules, dependency
folders committed to the repository (`node_modules`, `bower_components`, `.venv`, `venv`,
`site-packages`, `vendor`) and the files your `ignore` patterns and the defaults leave out of
reviews stay out of the map, and the output says how many and why (`--format json` lists each
one). A file that takes more than 2 seconds to parse, or that the parser cannot read, is left out
too.

## Cache

Phada keeps a mirror of each repository it reviews or indexes, and the map, in
`~/.cache/phada` (`$XDG_CACHE_HOME/phada` when set; `PHADA_CACHE_HOME` to choose another folder):

- `repos/<owner>/<repo>.git`: a bare git repository with only the commits Phada fetched (the 20
  most recently reviewed pull requests, the last indexed commit and, for a
  [related repository](#related-repositories), the head of its default branch), without their
  history and without your token;
- `index/<owner>/<repo>.sqlite`: the map built by reviews and by `phada index`, with its 10 most
  recent commits; a new version of Phada builds it again from scratch;
- `observed/<owner>/<repo>.sqlite`: the relations reviews learned (see
  [Repository graph](#repository-graph)); it survives new versions of Phada.

The mirror holds the source code of the repositories you review, private ones included, so
Phada creates these folders readable only by you. Everything there can be deleted at any time
(`rm -rf ~/.cache/phada`); Phada fetches what it needs again.

## Configuration

Phada reads two kinds of config, both optional:

- **The repository's**, shared with everyone who reviews it: `.phada/config.yml` and
  `.phada/rules.md` at the root. A `.phada/` folder in a subfolder adds rules, files and ignore
  patterns for that part of the tree; review options are only read at the root.
- **Your own**, in `~/.config/phada/` (or `$XDG_CONFIG_HOME/phada`, or `$PHADA_CONFIG_HOME`):
  `config.yml` and `rules.md` for every repository, and `repos/<owner>/<repo>/` (in lowercase)
  for one repository, which also works where you cannot commit.

`phada init` creates commented `.phada/` files in the current repository; `phada init --global`
creates your own config, and `phada init --global owner/repo` the one for a single repository.
Existing files are never overwritten.

```yaml
# .phada/config.yml
language: pt-BR
minConfidence: 60
verify: true
ignore: ['src/generated/**']
rules:
  - id: orm-only
    rule: Use the ORM for every query; never build SQL by hand.
    scope: ['**/*.py']
    severity: P1
disabledRules: [no-console]
context:
  defaults: true
  files:
    - path: docs/architecture.md
  repos: [acme/web]
```

| Key                       | What it does                                                                                                                                 | Where                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `provider`                | `claude`, `codex` or `ollama`                                                                                                                | your config             |
| `model`                   | Model for that provider                                                                                                                      | your config             |
| `localFiles`              | Files or folders on your machine to send as docs (a folder sends every `.md` in it); relative paths start at the folder of that `config.yml` | your config             |
| `language`                | Review language, like `--language`                                                                                                           | both (root)             |
| `minConfidence`           | Confidence cut, like `--min-confidence`                                                                                                      | both (root)             |
| `verify`                  | Verify findings, like `--verify`                                                                                                             | both (root)             |
| `investigate`             | `false` turns the [repository investigation](#repository-investigation) off, like `--no-investigate`                                         | both (root)             |
| `mcp`                     | Names of your Claude Code MCP servers the AI may use (see [Your AI's MCP servers](#your-ais-mcp-servers))                                    | your config             |
| `context.defaults`        | `false` sends only the files listed in `context.files`, not the docs Phada picks                                                             | both (root)             |
| `context.files`           | Files of the repository to always send (globs allowed), first in line for the budget                                                         | both                    |
| `context.repos`           | Other repositories the review may read (see [Related repositories](#related-repositories))                                                   | both (root)             |
| `context.privateOnPublic` | `true` lets a private related repository be read for a public pull request                                                                   | your config             |
| `ignore`                  | More files to leave out of the diff                                                                                                          | both                    |
| `rules`                   | Rules with `rule`, and optionally `id`, `scope` (globs) and `severity` (`P0`, `P1` or `P2`)                                                  | both                    |
| `watch`                   | Repositories `phada watch` follows and how (see [Watch mode](#watch-mode))                                                                   | your config (top level) |
| `history`                 | `false` keeps reviews out of the [history](#history)                                                                                         | your config (top level) |
| `disabledRules`           | Ids of rules from other config files to turn off; from a subfolder's `.phada/`, only inside that folder                                      | both                    |

Globs follow the usual `*`/`**` rules and are relative to the folder of the `.phada/` that
declares them (the repository root for your own config): `*.snap` only matches at that level, so
write `**/*.snap` for every folder; a leading `/` also means that folder. Exceptions with `!` are
not supported: list only the files to match.

`rules.md` is free Markdown with more rules; HTML comments in it are not sent. Rules, files and
ignore patterns from every config add up. For options, a flag wins over your config for that
repository, which wins over the repository's, which wins over your global config. A `model` only
applies with the `provider` set next to it, so `--provider ollama` never takes a model meant for
Claude. An invalid `.phada/` in the repository is skipped with a warning; an invalid config of
your own stops Phada with an error that names the file and the key.

## Options

| Option                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--provider <name>`    | AI provider: `claude` (default, unless your config sets one), `codex` or `ollama`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--model <name>`       | Model to use. Required for Ollama. Default: for Claude, the Claude Code default model, else `opus`; for Codex, the `model` in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), else the Codex CLI default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--language <tag>`     | Language of the review, e.g. `pt-BR`. The AI writes its text in it, and Phada's own headings and labels follow it in English (`en`) and Portuguese (`pt`, `pt-BR`); other languages keep those labels in English. Default: English                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--min-confidence <n>` | Confidence cut, a whole number from 50 to 100. Findings at the cut or above are shown and scored; the ones from 50 up to the cut are listed as worth checking. Default: 60                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--format <name>`      | Output: `markdown` (default) or `json`. The JSON (`schemaVersion: 1`) carries the same review as data: score, summary, every changed file, findings, findings worth checking, dropped counts, the verification (unless `--no-verify`), provider, model, time and tokens, a `publication` block (`published` with the URL, `failed`, `dry-run` with the exact body and comments, or `skipped`; with the number of findings `stillOpen` and `dismissed`), a `context` block (see [Rules and repository context](#rules-and-repository-context)), an `investigation` block (see [Repository investigation](#repository-investigation)) and an `impact` block (see [Repository graph](#repository-graph)) |
| `--no-investigate`     | Reviews without letting the AI read the rest of the repository (see [Repository investigation](#repository-investigation)); `--investigate` turns it back on when the config turns it off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--verify`             | Checks every finding with a second call to the AI before scoring (see above). On by default; `--no-verify` (or `verify: false`) turns it off, `--verify` turns it back on when the config turns it off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--no-resolve`         | Neither rechecks Phada's comments from earlier commits nor resolves the fixed ones (see [Comments fixed in a new commit](#comments-fixed-in-a-new-commit)); same as `resolveThreads: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--dry-run`            | Prints exactly what would be published (the review body and every comment) and posts nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--force`              | Reviews and publishes even when Phada already reviewed this commit (see [Publishing](#publishing))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--debug`              | Shows error details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Exit codes

| Code | Meaning                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | The review was published (or printed with `--dry-run`), Phada skipped a commit it already reviewed, or the pull request has no changes to review (or only ignored files) |
| 1    | Something failed: GitHub, the AI provider, an answer that is not a review, or publishing (the review is printed first)                                                   |
| 2    | The command line or your own config is wrong (unknown option, invalid pull request reference, invalid `config.yml`, …)                                                   |

`phada index` exits with 0 when the map was built and 1 when fetching or writing it failed.
`phada rules` exits with 0 when it printed the context and 1 when GitHub could not be read.
`phada watch` exits with 0 when it stopped or `--once` finished, 1 when it stopped on an error
(another watch running, an AI CLI that is not logged in, a token GitHub rejects), 2 when the
command line or your config is wrong, and 130 when a second Ctrl-C aborted it.

## What the AI sees

With Claude Code and Codex, the AI runs in an empty temporary directory and only sees the text
that Phada sends: the pull request, its diff, the rules and docs described in
[Rules and repository context](#rules-and-repository-context), and what it reads with Phada's
tools from the pull request head and from the [related repositories](#related-repositories) (see [Repository investigation](#repository-investigation)). Rules from `.phada/` and your
config are instructions; the pull request, the diff and the docs are data, and instructions
hidden in them are reported as findings. Phada only reads the `model` from their settings. An
`AGENTS.md`/`CLAUDE.md` in or above that temporary directory is never loaded, and the GitHub
token is removed from the environment of the AI process.

Claude Code runs without its own tools or your personal settings (hooks, plugins, skills,
`CLAUDE.md`). The only MCP servers it can use are Phada's and the ones your config names in
`mcp`.

Codex keeps a few built-in tools enabled that, with Codex CLI 0.160.0, can neither read your
files nor reach the network. Phada also turns off the apps connected to your ChatGPT account,
the shell, web search, plugins and sub-agents, and runs it read-only. Codex adds features
between versions, so the list of disabled features was checked with that version. Codex also
still reads your global `~/.codex/AGENTS.md` (or `$CODEX_HOME/AGENTS.md`) on every review, so
keep it free of instructions you do not want applied to your reviews.

### Local models with Ollama

```bash
ollama pull qwen2.5-coder:7b
phada review owner/repo#123 --provider ollama --model qwen2.5-coder:7b
```

Phada talks to Ollama at `127.0.0.1:11434` (or `OLLAMA_HOST`). It checks the model's context
window first and stops with an error when the pull request does not fit: it never lets the
model silently cut the diff.

- **Local models stay on your machine**, but without a GPU they are slow (minutes even for a
  small pull request) and small models follow instructions hidden in a diff more easily than
  large ones. Use them for small, trusted pull requests.
- **`:cloud` models** (e.g. `gpt-oss:120b-cloud`, after `ollama signin`) run on Ollama's servers:
  the diff leaves your machine. Some of them need paid Ollama credits.
- **A remote `OLLAMA_HOST`** (another machine or a hosted Ollama) also sends the diff off your
  machine, to that server.

## Status

Phada is in `0.x`: options and output can change between minor versions. The JSON output carries
a `schemaVersion` so scripts can tell when its shape changes. [CHANGELOG.md](CHANGELOG.md) lists
what changed in each version.

## Contributing, security and license

- [CONTRIBUTING.md](CONTRIBUTING.md) explains how to run Phada from source and send a change.
- [SECURITY.md](SECURITY.md) explains how to report a vulnerability privately.
- Tokens are read from environment variables only and are never printed. Phada never reads or
  manages the credentials of your AI CLI: authentication belongs to that tool.
- Phada is licensed under the [Apache License 2.0](LICENSE).
