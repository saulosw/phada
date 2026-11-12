# What a review reads

Everything a review sends to the AI besides the diff, and how to see it before a review runs: the
rules and docs of the repository and of your own config, the conversation and the CI checks of the
pull request, the review focus and the skills that change what the AI looks for, the prompt, and
what the AI can read on its own while it reviews (the repository investigation, the repository
graph, related repositories and MCP servers). How Phada indexes a repository for the graph is in
[Repository map](configuration.md#repository-map).

## Rules and repository context

Besides the diff, every review gets context from the repository and from your own config. All of
it is read from the **base commit** of the pull request, so a pull request cannot change the rules
that review it.

- **Rules** from `.phada/` in the repository and from your own config (see
  [Configuration](configuration.md#configuration)). They reach the AI as instructions: a change
  that breaks one is a finding that names the rule, even when nearby existing code breaks it too,
  and a rule can set the lowest severity of those findings.
- **Exceptions**: a rule with `kind: avoid` (and no `severity`) says what not to report in the
  files of its `scope`. It reaches the AI in its own block after the rules, "Repository
  exceptions", and never as something to break; the rest of those files is reviewed as usual, and
  a security hole, data loss or a crash is reported anyway. `phada rules` and the app mark it
  `avoid`. [Lessons](history-and-lessons.md#lessons) can write these rules for you.
- **Claude Code rules**: each `.claude/rules/**/*.md` file at the root is a rule too, named by its
  path (`.claude/rules/sql.md`). Its `paths:` front matter (one glob or a list, relative to the
  root) sets the files it applies to: it is sent when a changed file matches, and left out
  otherwise; a file without `paths:`, or whose front matter cannot be read (with a warning),
  applies to every file. Like the other rules they have no size budget: each one is sent whole, cut
  at 20 KB with a visible note and a warning. `disabledRules` turns one off by its path, and
  `context.defaults: false` stops reading them.
- **Docs** the AI reads as reference, in this order: the files your config lists; `README.md`,
  `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `.cursor/rules/*.mdc` in the folders of the changed
  files and above them; at the root, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`,
  `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`,
  `.cursor/rules/*.mdc`, `.cursorrules`, `.windsurfrules` and `GEMINI.md`; `CONTRIBUTING.md` and
  `README.md`; then the other Markdown files at the root and in `docs/` (changelogs, licenses and
  codes of conduct are left out). The docs the pull request changes come first, then the files
  your config lists, then the rest in that order. A change that breaks a convention written in them
  is a finding (P2 unless it also causes a bug or a security problem), even when nearby code does
  the same.
- **The docs budget**: docs share a 60 KB budget. A doc over 20 KB is cut at a line with a visible
  note; a doc that does not fit in what is left of the budget is cut the same way to what is left
  when at least 4 KB are left, and left out otherwise. Nothing is cut or left out silently.
- **Instruction files with a scope**: a `.instructions.md` file is sent only when a changed file
  matches its `applyTo`, and left out without one or with `excludeAgent: code-review`. A `.mdc`
  file is sent when it has `alwaysApply: true`, when a changed file matches its `globs`, or when it
  only has a `description`; one with none of these is meant to be attached by hand and is left out.
  A pattern without a `/` (`*.ts`) matches in any folder, a pattern starting with `!` excludes
  files, and the `globs` of a `.mdc` file in a subfolder's `.cursor/rules/` are relative to that
  subfolder. Files your config lists are always sent.
- **Ignored files**: lockfiles, minified files and source maps never reach the AI; `ignore` in the
  config adds more patterns. The review names every file it left out, so a change hidden in one of
  them is still visible to whoever reads it; when every changed file is ignored, Phada posts a
  short note that names them instead of a review.

Phada prints what it sent before the review, e.g.
`Context at base a1b2c3d: 2 rules · 5 docs (21.3 KB, 1 omitted, 2 not applied) · 1 file ignored`,
naming the base commit the context was read from (the summary above it names the head). "Omitted"
means a doc did not fit or could not be read, and "not applied" means an instruction file did not
apply to this change.

With `--dry-run` the preview ends with the full list, and the JSON has a `context` block with every
rule, doc and ignored file, where it came from, its scope and whether it was sent (`out-of-scope`,
`manual` or `excluded` when an instruction file did not apply). Findings list the docs and files
they rely on and the rule they break, in the JSON and under each comment on the pull request.

### See the context without a review

`phada rules` shows what a review reads besides the diff, without calling the AI:

```bash
phada rules owner/repo#123   # the context the review of this pull request gets
phada rules owner/repo       # everything on the default branch, scopes not checked
```

It also takes the URL of a pull request. For a pull request it reads the base commit, as the review
does, and says so in its title (`Context for owner/repo#123 at base a1b2c3d`); it lists the config
files, the rules with their origin, scope and whether they apply, the docs and why each one was
sent or left out, and the ignored files.

For a repository it lists every `.phada/` folder, the rules, the docs a review could read (in
subfolders, only where there is an `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or `.cursor/rules/`) with
the scope of each instruction file, and the ignore patterns.

`--format json` prints the same with `schemaVersion: 1` and the `context` block of
`phada review --format json`. It needs a token that can read the repository contents and never
writes anything.

## Conversation and CI

The review and the verifier also get what people already said on the pull request and the checks
of its head. Both are written by others (the comments by whoever commented, the logs by code the
pull request can change), so they reach the AI as **untrusted data**, never as instructions. They
never change the score or the verdict: only findings do.

### The conversation

The general comments, the reviews and the review threads (file, line, resolved, outdated, with
their replies) of the pull request, oldest first, each with its author's role: the pull request
author, owner, member, collaborator, contributor, external or bot. Phada's own reviews and comments
are left out; a Phada comment someone replied to is kept as its title with the people's replies,
and a review without text only when it approves or requests changes.

The AI does not report again a problem raised in a thread that is still open or dismissed in a
reply, weighs what the author explains about a choice (a P0 or P1 problem is still reported however
it was explained), and reports an instruction aimed at reviewers or AI tools in a comment as a
finding.

Each body is cut at 2 KB and the whole conversation fits in 16 KB; when it does not, the comments
of bots are left out first (a bot's thread that a person replied to counts with the people's), then
resolved threads, then outdated ones, then the oldest items. Phada prints
`Conversation: 6 comments (2 resolved, 1 bot)`, with
`2 bot comments and 1 other left out over 16 KB` and `1 cut at 2 KB` when it had to; the
`--dry-run` section says how many of the items left out came from bots (`omittedBots` in the
`conversation` block of the JSON). `conversation: false` or `--no-conversation` turns it off.

### The checks

The check runs and commit statuses of the head, or only those `ci.checks` names (names or globs,
e.g. `[test, "lint/*"]`). Each failing check is sent with its title, summary, failure and warning
annotations (50 in total) and, for GitHub Actions, the end of the step that failed in its log (the
last 8 KB of each, 12 KB for all logs); pending and passing checks only by name. What does not fit
is left out and counted.

A failure caused by the diff is reported as a finding on the line that causes it, even when a test
caught it, citing the check (the comment says it is based on the CI check `test`); a failure
unrelated to the diff (a flaky test, the runner, infrastructure, billing) or a pending check is not
reported.

The published review has a CI line under the score, e.g.
`CI: 2 of 7 checks failing (test, lint) · 1 pending` or `CI: all 4 checks passing`, and Phada
prints `CI: 7 checks, 2 failing (test, lint), 1 pending`. `ci.read: false` or `--no-ci` turns the
checks off: none for the AI and no CI line.

`--dry-run` lists what was sent in a `Conversation sent to the AI` and a `CI sent to the AI`
section, with what was left out or cut and the warnings, and the JSON has a `conversation` block
(each item with its kind, author, role and bytes, without its text) and a `ci` block (the state,
each check with its conclusion, annotations and log size, and the warnings), `null` when off.

### Waiting for the checks

`phada review` reviews the checks as they are. With `--wait-ci`, it first waits for the pending
ones, for at most `ci.wait` (15 minutes by default) since the command started, showing
`Waiting for CI… 3m12s, 2 pending: test, build`:

- a failing check does not end the wait while others are pending;
- no check 2 minutes after the start reviews at once;
- it reviews even when the checks fail;
- `ci.wait: 0s` does not wait;
- `ci.read: false` in the config warns and reviews at once;
- `--wait-ci` with `--no-ci` is an error.

[`phada watch`](watch-and-requests.md#waiting-for-ci) waits on its own, and can also skip commits
whose checks fail.

## Review focus and skills

By default the AI reviews as Phada's built-in reviewer: a senior engineer looking for bugs,
security issues, data loss, performance problems and risky design, for code that
[reimplements](publishing.md#reimplementations) what the repository already has and for changes
that break a convention written in the rules or docs. It leaves out style nitpicks, suggestions to
add tests or docs without a concrete risk, and what a linter or a test run would catch; test code is
reviewed like any other code.

You can change what it looks for, or have the review follow review skills you already use with your
AI CLI. Whatever the focus, the output format, the line numbers, the confidence and severity scales
and the rules about untrusted data stay Phada's, so every finding is still checked against the
diff, verified and scored the same way.

```yaml
# .phada/config.yml, or your own config
review:
  prompt:
    file: .phada/review.md # in your own config, relative to the folder of config.yml
    mode: append # append (default) adds to the built-in focus; replace swaps it
  skills:
    - phada # the built-in reviewer
    - security-review # a skill installed for your AI CLI
    - name: my-plugin:api-review # a skill of a plugin
      paths: ['src/api/**'] # only when a changed file matches
```

- **`review.prompt`** changes the built-in reviewer: `append` adds the text of the file as an extra
  focus, `replace` uses it instead of the built-in role, scope and list of what not to report. It
  is read like the rules: from the base commit for the repository's config, from your disk for your
  own. A missing or empty file stops the review before the AI is called.
- **`review.skills`** runs one review pass per skill, in order, and publishes one review with the
  findings of every pass; a finding two passes report on the same line with the same title is kept
  once. Each finding names the skill that found it in the terminal, the JSON and the history; on
  the pull request the skill is only in the hidden marker of the comment. `phada` is the built-in
  reviewer, with your `review.prompt` if there is one; leave it out to review only with your
  skills. `paths` runs a skill only when a changed file matches; otherwise the pass is skipped and
  the review says so. When no pass runs, nothing is published and Phada says which skills did not
  apply. A pass whose answer is not a valid review is left out with a warning and the others still
  publish; a provider failure (a usage or rate limit, a timeout) fails the whole review, so it can
  run again later.
- **`--skill <name>`** (repeatable) replaces the configured list for one run of `phada review` or
  `phada prompt`. `phada watch` uses only the config.

With several skills each pass takes about as long as a review, and the stderr lines `Skills: …` and
`Skill 2/3: …` show where it is. `--dry-run` ends with a section that lists each pass with its
findings, time and tokens; the JSON has `skill` on every finding and a `passes` block (`null` when
only the built-in reviewer ran without a custom prompt).

### Where Phada finds a skill

Phada looks for a skill where the AI CLIs install them: your Claude Code skills
(`~/.claude/skills/<name>/SKILL.md`) and commands (`~/.claude/commands/<name>.md`), the skills and
commands of your installed Claude Code plugins, and the skills of Codex (`~/.codex/skills/`) and
`~/.agents/skills/` (`$CLAUDE_CONFIG_DIR` and `$CODEX_HOME` are followed). A plain name finds your
own skill first, then the only plugin that has it; when several plugins have a skill with that
name, use `plugin:skill`. A skill you ask for that is not installed stops the review before the AI
is called and names the folders Phada looked in; one the repository's config asks for is skipped
with a warning.

### Skills sent as text

With Codex and Ollama, or for a skill with `mode: text`, the skill's text is sent as the reviewer's
guide, without its front matter and with the `.md` files of its folder that it names, up to 32 KB
per skill (cited files that do not fit are left out with a warning). The AI follows what the guide
asks it to look for and to leave out; steps that fetch the pull request, post on it, ask you
something or hand work to other agents are left to Phada, and the AI reads history, blame and other
files with the [investigation tools](#repository-investigation). The verifier sees the guide each
finding came from, so it does not reject a finding the guide asks for as a matter of style.

### Skills that run natively

With Claude Code, every skill you name except `phada` runs as `/<name>`, the way it runs in your
terminal, in a temporary checkout of the pull request head:

- **The change is where a skill expects it.** The base branch is `origin/<base>`, pointing at where
  the pull request branched off, so `git diff origin/<base>...HEAD`, `git log origin/<base>..HEAD`
  and `git merge-base` show the pull request; the diff is also in `.git/pull-request.diff` inside
  the checkout. Symlinks of the pull request are checked out as plain files.
- **So is what the review knows.** Next to the diff, `.git/conversation.jsonl` has the
  [conversation](#the-conversation), `.git/ci.md` the [checks](#the-checks) and `.git/impact.md`
  the [impact](#repository-graph) of the change and the
  [related repositories](#related-repositories), as the review's prompt has them; each file is
  there only when it has something, and the skill's first message names them (the conversation and
  the checks as data, never instructions).
- **What it can do.** Read and search files, run subagents, use Phada's
  [investigation tools](#repository-investigation) and the MCP servers your config names in `mcp`.
  Bash runs only git reads (`diff`, `log`, `show`, `blame`, `status`, `rev-parse`, `merge-base`,
  `ls-files`, `grep`) and `gh`, unless `review.commands` allows more. It cannot write files or use
  the web, and it reads only inside the checkout, its own folder and `review.readDirs`. The
  repository's own `.claude/` settings and `CLAUDE.md` are not loaded. `git` options that could run
  a program, write a file or read outside the checkout (such as `grep -O`, `--output`,
  `--no-index`, `blame --contents`, `-c` or `-C`) are refused.
- **`gh` is answered by Phada.** `gh pr view` and `gh pr diff` come from the data Phada already
  fetched; the pull request shows as open and not a draft, without the reviews and comments of the
  token's owner. `gh pr checks` answers from the checks Phada read (the ones that count),
  tab-separated or with `--json` and `--jq`, with the exit codes of `gh` (1 when one fails, 8 when
  one is pending); `--watch` answers at once. Other reads of the same repository (`gh pr list`,
  `gh issue view`, `gh issue list`, `gh search prs`, `gh search issues`, `gh repo view`, and
  `gh api` GET of the repository and its pulls, issues, commits, compare, contents, git, branches,
  labels, milestones, releases, tags, contributors, languages and readme) go through Phada with its
  token, up to 60 per pass; searches only ever look in that repository, and settings, secrets,
  alerts, webhooks and Actions are never read. `gh pr comment`, `gh pr review` and `gh api` posts
  of comments or reviews on this pull request are kept as the skill's output and **never sent**.
  Anything else fails with a message that lists what works; `--jq` takes paths like
  `.files[].path`.
- **Nothing leaks.** No GitHub token reaches the AI CLI, and the checkout and its folder are removed
  after the review, also on errors and Ctrl-C.
- **The output becomes a Phada review.** When the skill finishes, one more call to the same model
  turns what it tried to post (or else its final answer) into findings, in the skill's words, and
  the review goes on as usual: line checks, duplicates, verification, cut and score. The summary is
  the skill's. When none of its findings points at a changed line, the skill's output becomes the
  body of the review. `--dry-run` shows the skill's output and the JSON has it in
  `passes[].output`.
- **Text mode and built-in skills.** `{ name: my-plugin:review, mode: text }` sends a skill as text
  instead; `claude:<name>` names a skill built into Claude Code, which only runs natively.
- **Time.** A native pass can take many minutes, and skills that start several subagents use many
  tokens. `review.timeout` (default `30m`) limits each pass; one that runs out fails the review, and
  `phada watch` tries it again later like other timeouts.

```yaml
# ~/.config/phada/config.yml
review:
  commands: read-only # the default; or a list like ["npm test"]; or all
  readDirs: ['~/review-rules'] # folders a skill may read besides the checkout
  timeout: 30m
```

`review.commands`, `review.readDirs` and `review.timeout` are only read from your own config, never
from a repository's `.phada/`. A list or `all` lets the skill run those commands, and they run the
code of the pull request on your machine: allow them only for repositories you trust. A pull
request of a public repository from an author who is not an owner, member or collaborator always
runs read-only, without `readDirs`. Every command or read the skill was refused is shown on
stderr, in `--dry-run` and in the JSON (`passes[].blocked`) with the line that allows it:

```text
Skill my-plugin:review: ran natively in 6m12s, 1 GitHub write captured, 1 blocked
  blocked npm test (allow it with review.commands: ["npm test"] in ~/.config/phada/config.yml)
```

Text published on the pull request is checked for token patterns, which are replaced by
`[REDACTED]`.

### See the prompt

`phada prompt` shows the prompt a review would send, without calling the AI:

```bash
phada prompt owner/repo#123                     # the prompt of each pass for this pull request
phada prompt owner/repo#123 --skill security-review
phada prompt owner/repo#123 --head 1e6a005      # as a replay of that commit would send it
phada prompt --default                          # the built-in prompt, no token needed
```

For each pass it prints every part of the instructions with where it comes from (`phada`, the
`review.prompt` file, the skill's file, the rules) and the size of the data blocks (the pull
request, the docs, the [conversation](#the-conversation), the [checks](#the-checks) and the diff);
the conversation and the checks are read unless the config turns them off. A native pass shows the
message the skill gets, the context Phada adds, the commands and folders it may use, and the
instructions that turn its output into findings.

The tool sections are shown as a review sends them when the repository index is ready; the impact
of the change and related repositories are computed during a review and are not shown. With
`--head <sha>` it shows the prompt at that commit, with the conversation and the checks cut as in a
[replay](publishing.md#replaying-an-earlier-commit) and the warning when the cut is approximate.
`--skill <name>` (repeatable) shows the passes of those skills instead of `review.skills`.
`--format json` prints the same with `schemaVersion: 1`.

## Repository investigation

The AI can also read the rest of the repository while it reviews: who calls a function the pull
request changes, what a function it uses does, what the rest of a changed file does. Phada fetches
the head commit of the pull request into a local mirror of the repository (`git fetch --depth 1`,
with the GitHub token only in the environment of `git`; see [Cache](configuration.md#cache)) and
gives the AI tools of its own:

- `read_file`: up to 400 lines of a file per call, with line numbers;
- `grep`: a regular expression over the repository, up to 100 matching lines;
- `list`: the entries of a folder;
- `history`: the last 10 commits that changed a file, or who last changed some of its lines, with
  the pull request each commit came from (read from `(#123)` or `Merge pull request #123` in the
  commit message). The first call of a review deepens the mirror to the last 200 commits;
- `find_symbol`, `callers`, `dependencies` and `similar`: queries of the
  [repository graph](#repository-graph).

The tools only read that commit: no path outside the repository, no symbolic link, no binary or
file over 1 MB. Each review pass gets up to 40 calls and 512 KB of results; the verifier
investigates too, with its own budget. When the diff changes CI workflows, container files,
infrastructure code (Terraform, deploy and Kubernetes configs) or package manifests, the AI is told
to check what each of them affects. What the tools return comes from the pull request head, written
by its author, so it is data for the AI, never instructions. Findings still point to a line of the
diff, and the files the AI read to support them show up in their sources. The mirror stays for the
next review of the repository, which then fetches only what changed.

Claude Code and Codex reach the tools through a local MCP server that Phada runs for the review;
their own tools stay off. Ollama models use tool calling; a model that does not support it reviews
without the investigation, with a warning.

After the review Phada prints what the AI read, e.g.
`Investigated: 6 reads, 3 searches (41.2 KB)`. What counts is not the number of calls but the
[coverage](publishing.md#coverage): the AI accounts for every changed file and compares the new
files of 50 or more lines with the existing code closest to them.

### New code

When more than half of the added lines are in new files, the pull request mostly creates code, and
the prompt says so next to the size of the change, with the folders of the new files, e.g.
`New code: 82% of the added lines are in new files (src/billing/ 4 files, test/billing/ 2 files)`.
With the tools, the AI is then asked to find the existing code closest to the new code (a sibling
module, the same kind of handler, test or step) with `list`, `find_symbol` and `similar`, read it,
and compare the structure, the helpers it reuses and the conventions it follows, reporting what the
new code [reimplements](publishing.md#reimplementations) or does differently in a way that breaks
a convention or causes a bug. The [impact](#repository-graph) then also lists the existing code
similar to the new functions.

### What the investigation shows

With `--dry-run` the preview lists every call and, when the coverage is not full, each file left
out and why, and the JSON has an `investigation` block with each call, its size and whether a
finding used it. `--no-investigate` (or `investigate: false`) reviews the diff and the context
only. Without `git`, or when the head cannot be fetched, the review runs without the investigation
and says why.

### Repository graph

Before the AI starts, Phada builds the [map](configuration.md#repository-map) of the pull request
head (only the files it has not read before), resolves names to their definitions and works out the
**impact of the diff**: the functions, classes and types the pull request changes, the code that
calls or uses them and what they depend on. The AI gets that list, with the text of each calling
line, as the starting point of its investigation (only when a changed symbol has callers outside
the diff, or there is similar existing code; up to 4 KB, 20 changed symbols and 3 lines per file),
and Phada prints a summary:

```text
Impact: 3 changed symbols · 12 callers in 7 files
```

Names are resolved through relative imports, `tsconfig`/`jsconfig` `paths` and `baseUrl`, packages
of the same repository (by the `name`, `exports` and `main` of their `package.json`), Python
packages (relative imports, `src/` layouts, folders with a `pyproject.toml`, `setup.py` or
`setup.cfg`) and Go modules (`go.mod`). A method called on an object whose type Phada cannot see is
matched by name when one to three definitions have that name, and marked `inferred`; calls it
cannot resolve count as external.

In the impact, such a caller is kept only when the object it is called on names the class of the
changed method (`orderService.save()` for `OrderService.save`) or when only one function or method
has that name; the others may reach another symbol of the same name, so they are counted in the
symbol's line (`+2 matched by name only (unresolved, not listed)`) and not listed. The symbols that
already existed and changed come before the ones the pull request adds, and the same line of code
in several files is one line with the count and the first three places, e.g.
`logger.info(msg) — 14 calls in 9 files: src/a.ts:3, src/b.ts:7, src/c.ts:12, +11 more`.

When the pull request mostly creates code (see [New code](#new-code)), a `Similar existing code`
section lists, for up to 5 new exported functions and methods, up to 3 existing functions built
like each one, with the calls they share, for the AI to read before it judges the new code.

The AI can query the graph itself:

- `find_symbol`: where a function, class, method, type or variable is defined;
- `callers`: the code that calls, uses or inherits from a symbol, with each line;
- `dependencies`: what a symbol calls, uses and inherits, and where each is defined or which package
  it comes from;
- `similar`: functions built like a given one (the same calls, parameters and name), to check that
  a change follows the pattern of its neighbors.

Phada also learns from reviews: when the verification confirms a finding whose sources include a
file the AI read with the tools, and the graph has no link between the changed symbol and that
file, Phada keeps that link as an **observed** relation of the repository (in `observed/` in the
[cache](configuration.md#cache), on this machine only). Later reviews show it, marked
`observed #<pull request>`, after the static relations, for as long as both ends still exist.

The first index of a large repository can take minutes (about 2 minutes for 20,000 files). A review
waits for it for at most 60 seconds; after that it reviews without the graph, says so, and the next
review (or `phada index owner/repo`) continues where it stopped. `--dry-run` shows the impact sent
to the AI in an `Impact` section, and the JSON has an `impact` block with each changed symbol, its
callers, the relations the review learned and the text the AI got (`text`). `--no-investigate`
turns the graph off with the rest of the investigation.

### Related repositories

A change in a shared package can break code in another repository. List the repositories a review
may read as context, in the repository's `.phada/config.yml` (read at the base of the pull request)
or in your own config:

```yaml
context:
  repos:
    - acme/web
    - repo: acme/sdk
      description: SDK that wraps this API for the frontends
```

For each one, Phada fetches the head of its default branch into the
[cache](configuration.md#cache) and the AI can read it with the `repo` argument of `read_file`,
`grep`, `list`, `find_symbol`, `callers`, `dependencies` and `similar` (`history` stays on the
reviewed repository).

When a package manifest links the two repositories, Phada also indexes the related repository and
follows the link: the [impact](#repository-graph) of the diff lists the code in the other
repository that calls what the pull request changes, and `dependencies` points to the definitions
in a package the reviewed repository uses. The manifests it reads:

- `package.json` dependencies and `name`;
- `go.mod` `require` and `module`;
- for Python, the dependencies in `pyproject.toml` (`[project]` or Poetry) or `requirements*.txt`
  and the package name in `pyproject.toml`, `setup.py` or `setup.cfg`; the `install_requires` of
  `setup.py` and `setup.cfg` are not read.

Findings still point to a line of the diff; a file of another repository is cited as
`owner/repo:path`.

```text
Related: acme/web (consumer, 4 call sites) · acme/sdk (linked) · acme/admin (no link)
```

- Up to 7 related repositories are read per review: first those with code related to the change,
  then those linked by a package, then the rest, in the order they are declared (your config for
  this repository, then the repository's, then your global config). At most 20 are fetched.
- Linked repositories are indexed within 60 seconds in total; one that is not ready is read without
  its graph, and the next review (or `phada index owner/repo`) continues it.
- A private repository is never read for a public pull request, because what the AI reads may end
  up in the published review, unless your own config sets `context.privateOnPublic: true` (the
  repository's `.phada/` cannot).
- The related repository's own `.phada/` is never loaded: only the reviewed repository's rules
  apply, and what the AI reads in a related repository is data, like the pull request head.
- A repository you cannot read, an empty one, or one whose fetch fails is skipped with a warning;
  the review goes on. `--dry-run` shows a `Related repositories` section, and the JSON a `related`
  block with each repository, its commit, its link and why one was skipped.

### MCP servers

Your own config can give the AI MCP servers to read from during the review, for example the ticket
a pull request refers to. A server is either **named**, as your AI CLI already knows it, or
**declared** in Phada's config, for any provider:

```yaml
# ~/.config/phada/config.yml
mcp:
  - linear # a server of your Claude Code or Codex
  - name: 'claude.ai Linear' # a claude.ai connector, narrowed to some tools
    tools: [get_issue]
  - name: tickets # declared: Phada starts it
    command: npx
    args: [-y, '@acme/tickets-mcp']
    env: { TICKETS_TOKEN: '${TICKETS_TOKEN}' }
    description: The ticket cited in the pull request title; read it before judging business rules
  - name: docs # declared: streamable HTTP
    url: https://mcp.acme.dev/mcp
    headers: { Authorization: 'Bearer ${DOCS_TOKEN}' }
```

- **Named servers** run inside your AI CLI. With Claude Code, any server it has
  (`claude mcp list`; claude.ai connectors as `claude.ai <Name>`). With Codex, Phada reads the
  server with `codex mcp get <name> --json` and passes it to the run, keeping header and
  environment values off the command line. Every tool of a named server is allowed unless `tools`
  lists the ones to allow. Ollama has no servers of its own: declare them instead. A name your AI
  CLI does not know, or a server disabled in Codex, stops the command before the review.
- **Declared servers** are started (`command`, `args`, `env`) or reached over streamable HTTP
  (`url`, `headers`) by Phada itself, which offers their tools to the AI next to the
  [investigation tools](#repository-investigation), with Claude Code, Codex and Ollama alike, in the
  same budget of calls and bytes. Only the tools a server marks as read-only are offered; `tools`
  lists exactly the ones to allow instead, write tools included, at your own risk. A server that
  does not start or refuses the credentials is reported and the review goes on without it. HTTP
  servers that need an OAuth login are not supported: name them in your AI CLI.
- **Secrets** come from environment variables: `${NAME}` in `env`, `headers`, `args` and `url`,
  whole or inside a value (`Bearer ${DOCS_TOKEN}`). A value that looks like a secret written in the
  file (a token, or any value of a key such as `Authorization`, `*_TOKEN` or `*_KEY`) is refused
  when the config is read, and a variable that is not set stops the command before the review. A
  declared server gets your environment without the GitHub token, plus its `env`. The value of a
  variable used for a secret (a key or variable such as `Authorization`, `*_TOKEN` or `*_KEY`, or a
  value shaped like a token) is replaced with `[REDACTED]` in what the server answers and in its
  error messages; other values, such as `${HOME}`, are left as they are.
- `description` tells the AI what a server is for; it is added to the prompt only when a server is
  configured.

Servers are read only from your own config (never from the repository's `.phada/`), only while the
[investigation](#repository-investigation) runs, and never for a pull request of a public
repository from an outside author (not an owner, member or collaborator): Phada reviews those
without any of your servers and says so.

Calls count in the `Investigated:` line (`· 3 MCP calls (tickets, linear)`), `--dry-run` lists
each call and each server with its state and the tools it hid, and the JSON has them in
`investigation.calls[].server` and `investigation.mcp`. A finding based on a server cites it as
`<server>: <what it read>`. On a public repository Phada warns that what the AI read there may end
up in the published review.
