# Phada

> **Phada publishes by default.** `phada review` posts the review on the pull request as the
> owner of the GitHub token. Use `--dry-run` to only print it.

Phada reviews a GitHub pull request with the AI you already use — Claude Code, Codex or a model
served by Ollama — and publishes the review on the pull request.

It runs on your machine. Phada fetches the pull request, its diff, its conversation and its CI
checks, reads the repository's own rules and docs, sends them to the AI provider you choose,
lets the AI read the rest of the repository with read-only tools, checks that the answer is a valid review and scores it. It prints the review
as Markdown or JSON and posts it on the pull request: one comment on the line of each finding and
the rest in the review body (see [Publishing](#publishing)).

## Requirements

- Node.js 22.13 or newer
- `git`, for the repository investigation and `phada index` (without it, the AI only sees the diff and the context)
- A GitHub token that can read the pull request and write reviews, or the login of the GitHub CLI (`gh`) (see [GitHub token](#github-token))
- One AI provider:
  - [Claude Code](https://code.claude.com/) (`claude`), logged in with your subscription,
  - [Codex CLI](https://developers.openai.com/codex/cli) (`codex`, install with `npm i -g @openai/codex`, then `codex login`), or
  - [Ollama](https://ollama.com/download), running, with a model pulled (e.g. `ollama pull qwen2.5-coder:7b`)

## Install

```bash
npm install -g phada
phada
```

In a terminal, `phada` opens the [setup](#setup) while you have no config of your own: one step at
a time, it gets the GitHub token, the AI, the language and the repositories to watch ready, and
writes nothing before you confirm it. `phada setup` opens it again at any time.

Or run it without installing:

```bash
npx phada review owner/repo#123
```

## Usage

```bash
phada review owner/repo#123
phada review https://github.com/owner/repo/pull/123 --provider codex
```

Progress goes to stderr and the review to stdout, so `phada review owner/repo#123 > review.md`
saves only the review, and `--format json` prints it as JSON for scripts. A review of a large pull
request can take a few minutes. `phada review owner/repo#123 --dry-run` prints exactly what would
be posted and posts nothing.

`phada --help` lists the commands, and `phada review --help`, `phada setup --help`,
`phada init --help`, `phada index --help`, `phada rules --help`, `phada prompt --help`, `phada watch --help` and
`phada history --help` list their options. To have new pull requests and pushes reviewed without running anything, see
[Watch mode](#watch-mode); to see what happened to the comments Phada published, see
[History](#history). To see all of it in one place, run `phada` alone (see
[Terminal app](#terminal-app)).

### GitHub token

Phada reads the token from `GITHUB_TOKEN`, or from `GH_TOKEN` when `GITHUB_TOKEN` is not set.
Without either, it uses the login of the GitHub CLI: after `gh auth login`, every command works
with no variable to export. Phada asks `gh auth token` (or, on older `gh` versions without it,
`gh auth status --show-token`) once per run, only when a command needs GitHub, and never saves
or prints the token. The token reads the pull request and its reviews and publishes a review, so the token needs:

- a fine-grained token with **Contents: Read-only** and **Pull requests: Read and write** on the
  repository, plus **Checks: Read-only**, **Commit statuses: Read-only** and **Actions:
  Read-only** for the [CI checks](#the-checks), or
- a classic token with the `repo` scope (`public_repo` is enough for public repositories).

A read-only token is enough with `--dry-run`. Without write access, Phada still prints the review
and then stops with an error that names the missing permission. **Contents: Read-only** lets
Phada read the repository's rules and docs (see [Rules and repository context](#rules-and-repository-context));
without it, the review runs on the diff alone and says so. Without one of the CI permissions, the
review runs without that part of the checks and warns with the permission the token lacks, e.g.
`CI check runs were not read: GitHub denied reading the check runs (HTTP 403): the token needs the checks:read permission.`

## Terminal app

Run `phada` with no command in a terminal to open the app: what Phada has set up, running and
reviewed, in one place, without remembering commands or folders, and the [setup](#setup) and the
[changes to your config](#changing-your-config-from-the-app) you would otherwise write by hand.
It opens on the terminal's alternate screen, like `less` or `vim`, and the terminal is back as it
was when you quit.

```bash
phada
```

| Screen       | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home         | One line each for GitHub (where the token comes from and whose it is), the AI (installed and logged in), the watch, the queue and the repository maps; the last reviews; and what to do next, with the command                                                                                                                                                                                                                                                                                                                                                                    |
| Repositories | The watched repositories, the ones with a config of their own and the ones in the history → the settings of each with where every value comes from, its watch filters, its map, its related repositories and its last reviews (and, for a watched one, whether it publishes); `w`, `p`, `a`, `e` and `R` change them, `i` indexes it, `v` reviews one of its open pull requests                                                                                                                                                                                                   |
| Rules        | The reviewer lens and your rules at once; the repository's `.phada/` and the rules and docs a review of the default branch reads; `p` and a pull request number show what a review of it reads and its prompt                                                                                                                                                                                                                                                                                                                                                                     |
| Reviews      | The history, with `f` to filter → one review with its score, findings, what was published, the CI line and what happened to each comment; `n` reviews a pull request                                                                                                                                                                                                                                                                                                                                                                                                              |
| Queue        | The watch running in this app, in another terminal (with its PID) or not running, its last and next cycle, the job running (with the step of its review when the watch runs here), the jobs queued, waiting for CI, skipped for failing CI or failed, a pause, the reviews this hour and the log of the watch started here → a job with its requests; `w` starts or stops the watch, `l` opens its whole log                                                                                                                                                                      |
| Automation   | The watch, the CI wait, the request sources that are on (pull request comments, `phada enqueue`, `phada mcp`, Slack), the hooks and the `when` commands                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Provider     | The provider and model you chose and where they come from, the language, each AI checked (installed, logged in, Ollama running and its models) with the command that fixes it, and your MCP servers; `c`, `L` and `l` change them                                                                                                                                                                                                                                                                                                                                                 |
| Graph        | The [map](#repository-map) of each repository of the Repositories screen: whether it is indexed, its commit, files, symbols and size → its commit and branch, when it was indexed and how long it took, its files per language, its symbols by kind, its imports, exports, calls and uses, and the files left out and why, and its connections: each related repository it declares (`context.repos`) linked by the packages one publishes and the other uses, without a link, or not indexed and why; `i` indexes it and `I` the related ones not indexed; `s` explores a symbol |
| Learnings    | Per repository, the relations learned from reviews and what happened to Phada's comments, per repository and per rule                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Keys: `←`/`→` or `Tab` move between screens, `1`–`9` jump to one, `/` finds a screen by name (and
`/setup` the setup, `/language` the language, `/index` the Graph, `/review` a review), `?` lists every key, `↑`/`↓` and `Enter` open an
item, `Esc` goes back, `r` reads again what comes from GitHub or the AI CLIs, and `q` quits. The footer lists the keys of the screen you are on.

What is on your machine (the config, the history, the queue) is read every 2 seconds; what comes
from GitHub or the AI CLIs is read when a screen opens and on `r`. The app writes only what
[Changing your config from the app](#changing-your-config-from-the-app) lists, and the history
only for a review or the watch you run from it, as `phada review` and `phada watch` do (just
reading it never creates its file). It reads each map without changing it: a map that is
missing, made by another version of Phada or that cannot be read is shown as such on the Graph
screen, until you index it. The connections of the Graph come only from your machine: the
manifests and the `.phada/config.yml` of the indexed commit, read from the local copy the index
was built from, never fetched. It needs a terminal of at least 80×24 and says so
when it is smaller. It follows the `language` of your config (English,
Portuguese and Spanish), uses the full colors your terminal supports (down to 16), and none with
`NO_COLOR` or `TERM=dumb`. `q` exits with 0, Ctrl-C with 130 and `SIGTERM` with 143. Outside a
terminal (a pipe, a script), `phada` with no command prints the same error as before, and
`phada setup` stops with a usage error.

### Setup

`phada setup` opens the app on the setup; `phada` alone opens it while your own `config.yml` does
not exist, and `/setup` opens it from any screen, from its first step. It has seven steps, shown as `Step n of 7`: `s`
skips one, and `Esc` asks whether to leave the setup for the Home (what you confirmed is already
written, and `phada setup` starts again).

1. **GitHub**: where the token comes from (`GITHUB_TOKEN`, `GH_TOKEN` or the `gh` login) and
   whose it is. Without a token, or when GitHub refuses the token of the `gh` login, `Enter`
   hands the terminal to `gh auth login` and checks again when it ends. Without `gh`, it says how
   to install it or to export `GITHUB_TOKEN`; a token from a variable that GitHub refuses has to
   be replaced or unset.
2. **AI**: Claude Code, Codex and Ollama, each checked (installed, logged in, running), and `r`
   checks again. Choosing a CLI that is not logged in hands the terminal to its login
   (`claude auth login`, `codex login`) and checks again when it ends; the credentials stay with
   the CLI. A CLI reviews with its own default model or one you type. When Ollama is not running,
   the step says to start it with `ollama serve` and press `r`; when it runs, you pick an
   installed model, type one, or take the suggested `qwen2.5-coder:7b` (about 4.7 GB). A model
   Ollama does not have is pulled through its API (at `OLLAMA_HOST` too), with its progress, and
   `Esc` cancels the pull.
3. **Language**: English, Portuguese or Spanish, for the app and the reviews; the app speaks it at
   once.
4. **Repositories**: the repositories of the token owner on GitHub (owned, as a collaborator and
   of your organizations, without the archived ones, most recently pushed first), with the ones
   already in `watch.repos` marked and first. `f` filters the list, `Space` marks or unmarks one,
   `a` adds an `owner/repo` that is not listed, and `Enter` saves the marked ones to
   `watch.repos`.
5. **Graph**: builds the [map](#repository-map) of each watched repository, one at a time, with
   `N of M files`. `Esc` stops: what was extracted is kept, and `phada watch` finishes it when it
   is idle, or `phada index owner/repo` now.
6. **This repository**: when the app runs inside a git repository without a `.phada/` folder,
   `Enter` runs `phada init` there and lists the files it created.
7. **Summary**: what was written and to which file, what was indexed or left for later, what
   `phada init` created, the steps skipped, and what to run now (`phada watch` when a repository
   is watched, `phada review owner/repo#N`).

A step that changes your config shows the change first, one line per value
(`provider claude → codex`, `watch.repos + owner/repo`), and writes it only on `Enter`; `Esc`
cancels it.

### Reviewing a pull request from the app

`/review` in the palette, `n` on the Reviews screen or `v` on a repository of the Repositories
screen open the review in place of the tabs:

1. **The pull request**: type `owner/repo#N` or its URL and `Enter` (anything else is refused on
   the spot), or pick a repository (`Esc` leaves the field, `t` types again) → its open pull
   requests from GitHub, with their number, title, author and whether they are drafts (`r` reads
   them again). `v` opens straight on the open pull requests of that repository.
2. **The mode**: **Only look** reviews here and posts nothing, as `phada review --dry-run`;
   **Review and publish** posts the review on the pull request. While a `phada watch` runs (in
   the app or in another terminal), it becomes **Put in the queue**: the watch reviews and
   publishes it, as `phada enqueue owner/repo#N --publish pr`, and the result is the new job, the
   job it joined or why the queue refused it, with `Enter` to the Queue. Only look still runs
   here.
3. **For publishing**, the pull request and the GitHub login that will publish it (the owner of
   the token) to confirm: `Enter` publishes, `Esc` goes back. Without a token it does not offer to
   publish.
4. **The steps, live**: the pull request fetched (with a note under it when it is closed or a
   draft, which it still reviews, as `phada review` does), the context, the conversation, the CI, the
   indexing (`N of M files`), the related repositories, the impact, each run of the AI (review,
   verify, recheck, skill) with its time, publishing, and the warnings. `Esc` asks before
   cancelling (`Enter` cancels, `Esc` keeps it running): Phada stops the AI CLI, posts nothing
   and saves nothing in the history. Once it publishes, it no longer cancels.
5. **The result**: the same detail as the Reviews screen (score, verdict, findings with their
   text, what was published or, for only look, that nothing was posted, what it would resolve or
   why it would skip, the CI), how long it took and whether the history kept it. A failed review
   shows its error; with `phada --debug`, also its causes and stack. `Esc` goes back to the
   screen you came from.

It is the same review as `phada review owner/repo#N` (with `--dry-run` for only look): the
provider, model and MCP servers of your config for that repository, your GitHub token, and the
run saved in the history unless `history: false`. The AI CLI runs in its own process group, so it
never writes on the app. `Esc` goes one step back; the palette stays closed while the review is
open, so it is left only with `Esc`. While a review runs, `q` and `Ctrl-C` ask
before quitting (`Enter` cancels it and quits, waiting for a publication under way; `Esc` stays;
a second `Ctrl-C` cancels and quits at once).

### Running the watch from the app

`w` on the Queue screen, or `/watch` in the palette from any screen, starts the watch in the app:
the same watch as `phada watch` (your `watch:` settings, the lock, the history, the hooks and
Slack), until you stop it. The Queue says whether the watch runs in this app, in another terminal
(with its PID; `w` then only says so) or not at all, and what kept it from starting, in one line.
Under the jobs, its log: what it queued, started, published, skipped or retried, its warnings, the
time of each line, and the step of the review under way on the running job; `l` opens the last 200
lines. With the watch running here, `w` (or `/watch`) asks before stopping it after the current
review; `Enter` stops, `Esc` keeps it running. Quitting with `q`, `Esc` or `Ctrl-C` asks too:
`Enter` lets the current review finish and quits, a second `Ctrl-C` stops the AI at once and puts
the pull request back in the queue, and a `SIGTERM` does that without asking. A review you start
from the app while the watch runs here (only look) has its own AI CLI: cancelling one never stops
the other.

### Changing your config from the app

- **Provider**: `c` changes the AI and its model (the choice of the setup's AI step, with the
  login or the model pull there), `L` changes the language and `l` logs in to the chosen AI CLI
  again (or to one that is not logged in). `/language` changes the language from any screen.
- **Graph** and **Repositories**: `i` indexes the selected (or open) repository, or indexes it
  again, with `N of M files` as it goes; `Esc` stops it, and the screen reads the map again when
  it ends. Leaving the screen stops it too. On an open repository of the Graph, `I` indexes the
  related repositories it declares that are not indexed yet.
- **Graph**: on an open repository, `s` asks for a symbol name and searches the
  [graph](#repository-graph) the review uses, linked to the related repositories it declares that
  are indexed and linked by package. Several definitions are listed to pick one; one opens as a
  tree with its callers and its dependencies: `Enter` or `→` opens a node one level (a caller into
  its own callers, a dependency into its own dependencies, across the linked repositories), `←`
  closes it, and `Tab` moves between screens meanwhile. Each level shows 20 items and how many
  more, and says when the graph cut the list short. A name not found or a repository that is not
  indexed says so, with `i` to index it. Everything is read from your machine; the app keeps the
  graph of one repository open at a time.
- **Repositories**: on the selected repository, `w` watches or unwatches it, `p` turns its
  `publish` on or off, `a` adds repositories from your GitHub list or typed, and `e` and `R` open
  its own `repos/<owner>/<repo>/config.yml` and `rules.md` (in your config folder) in `$VISUAL`,
  `$EDITOR` or `vi`, created with a commented header when they do not exist. The app is back when
  the editor exits, with the file read again.

Like the setup, each change shows what it does before → after and is written only on `Enter`.
The app writes:

- your own `config.yml`: `provider`, `model`, `language` and `watch.repos` (a new file gets the
  values on top and the commented template of `phada init --global` below them);
- the `repos/<owner>/<repo>/config.yml` and `rules.md` you open in the editor, created when they
  do not exist and never overwritten;
- the [map](#repository-map) of a repository when you index it in the setup or with `i` on the
  Graph and Repositories screens, in the cache, as `phada index` does (on its default branch,
  replacing a map made by another version of Phada or that cannot be read);
- a repository's `.phada/` only through `phada init`, in the setup's step 6;
- the [history](#history), with a review or the watch you run from the app, as `phada review` and
  `phada watch` do (the watch also takes its lock and keeps the index of each default branch up
  to date).

Comments, the order of the keys and the lines a change does not touch stay as you wrote them. When
a line cannot be kept as written (an indentation of 4 spaces, for example), the change says that
the file is rewritten in a standard layout before you confirm it. The new text is checked like any
config before it is written, and it is written atomically (a temporary file renamed over it); a
symbolic link stays a link, and the file it points to changes. A config file that is already
invalid is never edited: the app shows its error and offers no change. If the file changed after
the change was shown, `Enter` shows it again.

While a login or the editor runs, the terminal is theirs and Ctrl-C goes to them, not to the app.
The login of an AI CLI runs without `GITHUB_TOKEN` and `GH_TOKEN` in its environment.

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

  A finding at most 10 points above the cut is marked **close to the cut**: the AI does not
  rate a finding the same way every time, so another run of the same commit may leave it out.
  The mark and their count show in the terminal review, in a "Close to the cut" section of
  `--dry-run`, in `closeToCut` of each finding in `--format json` and the history, and in the
  review's detail in the app; the comments posted on the pull request do not carry it.

- **Worth checking**: up to five findings with confidence from 50 up to the cut, one line each.
  They do not change the score.
- **Repository debt**: problems that are real but that this change neither introduces nor worsens
  (an exported function no caller uses that the change only touches, say), one line each with its
  place and why. See [Repository debt](#repository-debt).
- A footer with how many findings there are, how many are worth checking, how many were dropped
  (rejected by verification, outside the diff, duplicates, below confidence 50, not in the
  expected shape, or repository debt with `review.debt: off`) and the provider, model, time and
  tokens.

At the end, `phada review` prints on stderr the tokens of each call to the AI (each review pass,
one per skill, the verification and the recheck of earlier comments; a native skill counts its run
and the conversion of its output together) and their total: the input tokens, how many of them
came from the provider's cache, and the output tokens, e.g.
`Tokens: review 812.0k in (640.0k cached) · 9.0k out; verify 120.0k in · 2.0k out; total 932.0k in (640.0k cached) · 11.0k out`.
A provider that does not report them shows `not reported` (Ollama reports no cache). The same
counts are in a "Tokens" section of `--dry-run`, in `usage` of `--format json` and the history
(`passes` with `pass`, `skill` and `usage`, and the `total`), in the review's detail in the app
and next to each AI step while the app runs a review.

By default (turn it off with `--no-verify` or `verify: false`), the first pass asks the AI for every
candidate from confidence 25 instead of 50, and Phada makes a second call to the same AI before
scoring. It sends the pull request, the diff and the candidates, without their severity and
confidence, and asks a skeptical reviewer to confirm each one, with its own severity and confidence,
or reject it. A finding is confirmed only when it can happen in the repository under review: when
the effect it claims depends on a condition (a setting, the callers, the log level, a flag, the
inputs that reach the code), the verifier looks for that condition with the
[investigation tools](#repository-investigation) (without them, in the diff) and rejects the
finding, naming what is missing, when the repository does not meet it; how a library behaves on its
own is not enough. Rejected findings leave the review and are counted in the footer; `--format json`
lists them with the reason, and gives the verifier's reason for every confirmed finding too (`null`
for a finding it did not check). Confirmed findings still below 50 are dropped like any other. A
finding without an answer keeps its first rating and the footer says how many were left unchecked
(`not verified` when none got an answer). Verification adds about half the time and doubles the
tokens; the time and tokens shown are the total of both calls.

If the AI's answer is not a valid review, Phada stops with an error instead of printing it;
`--debug` shows the start of the answer.

### Claims of the description

The title and description of a pull request are the author's account of the change, so the
review checks them instead of repeating them. The AI lists each concrete, checkable thing they
assert the change does or guarantees ("X prevents Y", "covers Z", "is backward compatible",
"only runs on main") and checks it against the diff and, with the tools, the repository:
`confirmed` or `contradicted` with the file and line that show it, or `unverified` with what is
missing. A contradicted claim that matters is also reported as a finding at the line that breaks
it, and the summary never states an unverified or contradicted claim as fact. The description
stays data to check: an instruction in it is never followed. The claims show in a "Claims of the
description" section of `--dry-run`, in `claims` of the review in `--format json` and the
history, and in the review's detail in the app; they are not posted on the pull request. When
several skills review the pull request, the same claim is kept once, with the strongest verdict
(contradicted, then confirmed). An AI answer without the list still gives a review, with a
warning that the claims were not checked. A skill that runs natively has its claims taken from
what it wrote: a claim it does not settle is `unverified`.

### Repository debt

The AI marks each finding with its scope: `change` when this pull request introduces or worsens
the problem, `repository` when the problem is already there and the change only moves or touches
the code. A finding without a scope is a finding of the change. `review.debt` decides what happens
to the ones of the repository:

- `summary` (default): they are not posted as line comments. The review body lists them under
  "Repository debt", one line each with severity, file and line, title and a short why, and they
  count neither in the score nor in the verdict. The ones below the confidence cut stay in "Worth
  checking" like any other.
- `comments`: they are posted and scored like every other finding.
- `off`: they are dropped and counted in the footer (`debt` in `dropped` of the JSON).

`--format json` and the history give the `scope` of every finding and the `debt` list of the
review; the app marks a finding of the repository and shows the debt in the review's detail.

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
  and the suggested fix, and a "Based on" line with the evidence (the files and CI checks it
  relies on) and the rule it breaks; the skill that found it stays in a hidden marker of the
  comment and in the history;
- the review body starts with the butterfly and the score (`## 🦋 3/5 (implementation issues)`)
  and has the summary, the changed files, how many findings were posted, the findings worth
  checking, the [repository debt](#repository-debt) and what was dropped; it names neither Phada
  nor the provider and model;
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
a comment whose file did not change stays open without asking the AI, and so does one Phada
cannot check (no comparison after a rebase and no access to the repository with
`--no-investigate`). The AI answers `fixed`, `still-valid` or `unsure` for each one, and Phada
only acts on `fixed`: right before posting the new review, it resolves the thread and replies
"Fixed in `abc1234`: …" with the reason. A comment that is still valid or unsure stays open,
Phada never reopens a thread, never touches threads of other people, leaves alone a thread a
person reopened after Phada resolved it, and a failure on one thread does not stop the others
(the run says "Resolved N of M comments found fixed" and warns about each failure). The new review does not post again a finding of a
comment found fixed in the same run; if the problem comes back in a later commit, it is posted
again, while a finding whose thread a person resolved is never posted again. `--dry-run` says
what it would resolve and resolves nothing, and nothing is resolved when publishing is off.
Turn it off with `resolveThreads: false` in a config file or `--no-resolve`. The JSON has a
`recheck` block with every verdict and `resolved` counts in the `publication` block.

### Pushes that change nothing to review

Every review keeps a fingerprint of the reviewed diff, without the files left out of the review
and without the line numbers of its hunks. A new commit whose diff has the same fingerprint as the last
Phada review of the pull request is skipped without calling the AI: a push that only touches
ignored files, or a merge of the base branch that only moves the changed lines, does not trigger
a new review. `--force` reviews anyway and `--dry-run` says it would skip.

Text written by the AI cannot mention anyone, link other issues or pull requests (`#12`, `owner/repo#12`), add HTML or forge Phada's own markers, and a body
longer than GitHub allows is shortened with a visible "(truncated)". Two runs on the same pull
request at the same time can both publish. GitHub refuses a new review while you have a pending
review of your own open in its interface; submit or discard it first.

## Watch mode

`phada watch` follows the repositories you list in your own config and reviews new pull
requests and new pushes on its own, one at a time, and publishes them like `phada review`. The
[setup](#setup) and the Repositories screen of the app list them for you; the other keys are
written by hand:

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
phada watch --status     # the queue (and jobs waiting for CI), reviews in progress, failures, last reviews
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
- Before a job starts, the watch reads the [checks](#the-checks) of its commit. While some are
  pending, the job waits for CI (`waiting` in `phada watch --status`, with until when and the
  pending checks), read again every minute, for at most `ci.wait` (15 minutes by default, `0s`
  turns it off) after the watch saw the commit; then it is reviewed with the checks as they are.
  A failing check does not end the wait while others are still pending, so the review gets the
  result of the whole pipeline. A commit without any check 2 minutes after the watch saw it, or
  whose checks all ended, is reviewed at once, and so is one whose checks cannot be read (with a
  warning). A push replaces a waiting job like a queued one, a request joins it and reads the
  checks again at once, and waiting does not count in `maxReviewsPerHour`.
- With `ci.onFailure: skip`, a commit whose checks fail is not reviewed: the job is skipped as
  `ci-failing` (in the history, the `review.skipped` event and Slack), its checks are read again
  every `interval` for 24 hours, and the same job is reviewed once they no longer fail. A request
  for that commit reads them again at once. A new push ends it: the new commit is reviewed on its
  own, and the requests of the skipped one move to it.
- Drafts and pull requests opened by bots are never picked up by the polling (someone can still
  [ask for them](#asking-for-reviews-from-anywhere)). On a public repository, only
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

## Asking for reviews from anywhere

Besides its own polling, the watch reviews what people and tools ask for. Phada knows nothing
about chat apps or mail: it takes **review requests** through three doors (`phada enqueue`,
`phada mcp` and a `/phada review` comment) plus one built-in client, Slack, and it sends
**review events** to your hooks. Every request goes through the same checks, whatever asked for
it, and is refused with a reason when it fails one:

- the repository is listed under `watch:` in your own config (`not-watched`);
- the pull request is open (`closed`);
- on a public repository, the author is an owner, member or collaborator unless the repository
  sets `allowExternal: true` (`external`);
- the [`when` command](#a-condition-of-your-own) of the repository lets it through
  (`when-command`);
- the commit was not already reviewed (`already-reviewed`, with that review);
- fewer than `maxReviewsPerHour` new reviews were queued in the last hour (`hourly-limit`).

A request for a commit that already has a job waiting or running joins that job: one review, and
everyone who asked hears back. The one exception is a request that publishes while the running
job does not: it gets a review of its own once that one ends. A request is reviewed at once, without the `settle` time, and the
filters of `watch:` (`authors`, `labels`, `baseBranches`, drafts) only decide what the polling
picks up: a draft someone asks for is reviewed. When the pull request gets a new commit before
its review starts, the request moves to the new commit. Each request says where the review goes:
`pr` (the default) publishes it on the pull request, `none` keeps it in the history and the
events only. The review is the same either way.

Requests wait in the queue of `phada watch`, which runs them; with no watch running they wait
until one starts.

### From a script: `phada enqueue`

```bash
phada enqueue owner/repo#123                 # exit 0 when queued or joined, 1 when refused
phada enqueue owner/repo#123 --publish none  # review it without posting on the pull request
phada enqueue owner/repo#123 --format json
```

For example, from cron every morning:
`0 9 * * 1-5 phada enqueue acme/shop#42 --publish none`.

### From your AI: `phada mcp`

`phada mcp` is an MCP server over stdio. Add it to your AI CLI, for instance
`claude mcp add phada -- phada mcp`, and the AI can ask for a review and wait for the answer:

| Tool                  | What it does                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `review_pull_request` | `pr` (`owner/repo#N` or a URL) and `publish` (`pr` or `none`): queues the review, joins the one already queued, or says why it was refused |
| `job_status`          | The state of a job, its place in the queue and, once it ended, its event                                                                   |
| `wait_for_job`        | Waits until the job ends (`timeoutSeconds`, 300 by default, 1800 at most) and returns its event with the full review                       |
| `list_queue`          | The jobs waiting and the one running                                                                                                       |

The AI asks; Phada decides. A message that talks the AI into asking for a review of some other
repository is refused like any other request. `phada mcp` needs a GitHub token (`GITHUB_TOKEN`,
`GH_TOKEN` or the `gh` login) to read the pull requests asked for.

### From the pull request: `/phada review`

An owner, member or collaborator of a watched repository can comment `/phada review` (as the
first line) on a pull request. The watch reads the new comments of each repository once per
`interval`, reacts with 👀 to the ones it takes and reviews the pull request; the review is
published on it. Comments from anyone else, from bots, or older than when the watch first saw
the repository are ignored.

### Slack

With `slack:` in your own config, `phada watch` also listens to the Slack channels you list
(Socket Mode, so no public URL is needed) and reviews the pull requests linked in their messages:

```yaml
# ~/.config/phada/config.yml
slack:
  channels:
    - C0123ABCD # the channel ID, at the bottom of the channel details
    - id: C0456EFGH
      publish: none # pr (default) or none: answer in Slack only
      reply: full # link (default), summary or full
  emojis: # optional; these are the defaults
    queued: hourglass_flowing_sand
    clean: white_check_mark
    comments: speech_balloon
    blocking: x
    failed: warning
    skipped: eyes
```

```bash
export PHADA_SLACK_BOT_TOKEN=xoxb-…   # the bot token of your Slack app
export PHADA_SLACK_APP_TOKEN=xapp-…   # an app-level token with connections:write
phada watch
```

The Slack app needs Socket Mode on, the bot scopes `channels:history` (and `groups:history` for
private channels), `chat:write` and `reactions:write`, the `message.channels` (and
`message.groups`) events, and to be invited to the channels. The tokens are only read from the
environment. A message with up to five pull request links of watched repositories gets ⏳ and,
when each review ends, the emoji of its verdict and an answer in its thread: `link` (the
verdict and the links), `summary` (plus the summary, the score and the counts) or `full` (plus
every finding with a link to its line in the reviewed commit, split into several messages when
long). A commit Phada already reviewed is answered with the link of that review. A commit skipped
for [failing CI](#watch-mode) gets the `skipped` emoji and `CI failing: test, lint. It is
reviewed once these checks pass.`; once it is reviewed, that emoji gives way to the verdict's.
A refused request is answered with the reason; messages in other channels, from bots, or with links to
repositories outside `watch:` are left alone.

### Review events and hooks

```yaml
# ~/.config/phada/config.yml
hooks:
  review.started: ./notify.sh started
  review.finished: ./notify.sh
  review.failed: ./notify.sh
  review.skipped: ./notify.sh
  timeout: 30s # how long a hook may run (default 30s, 10m at most)
```

Each hook is a shell command run from your config folder, with your environment (tokens
included, as in your own shell: do not let a hook print it), for the jobs of the queue. It gets
the event as JSON on stdin (`schemaVersion: 1`):

```json
{
  "schemaVersion": 1,
  "event": "review.finished",
  "job": {
    "id": 7,
    "repo": "acme/shop",
    "number": 12,
    "headSha": "a1b2…",
    "url": "https://github.com/acme/shop/pull/12"
  },
  "requests": [
    {
      "source": "slack",
      "publish": "none",
      "data": { "channel": "C0456EFGH", "ts": "1729688400.1", "thread": "1729688400.1" }
    }
  ],
  "verdict": "blocking",
  "ci": {
    "state": "failing",
    "checks": [
      { "name": "test", "state": "failing" },
      { "name": "lint", "state": "passing" }
    ]
  },
  "publication": { "status": "not-published" },
  "review": { "...": "the same JSON as phada review --format json" }
}
```

`source` is `watch`, `enqueue`, `mcp`, `pr-command` or `slack`, and `data` is what that source
brought. `review` comes with `review.finished`, `reason` with `review.skipped` (`superseded`,
`closed`, `already-reviewed`, `ci-failing`, …) and `error` with `review.failed`, which is only
sent once the job gave up. `ci` is the state of the [checks](#the-checks) (`none`, `pending`,
`passing` or `failing`) and each check that counts, once the review or the watch read them (in
`review.started`, as the watch read them before starting the review); `null` when the checks were
not read. A hook that fails or runs out of time is reported in the watch and never stops it.

The **verdict** is computed by Phada from the findings, never by the AI: `blocking` when a
finding is P0 or P1, `comments` when there are only P2 findings or findings worth checking,
`clean` when there is nothing, `failed` and `skipped`. It is also in the JSON of every review and
in the history.

### A condition of your own

```yaml
# ~/.config/phada/config.yml
watch:
  when: { command: ./only-payments-team.sh } # for every repository
  repos:
    - acme/shop
    - repo: acme/web
      when: { command: ./web-rules.sh } # instead, for this one
```

The command runs like a hook and gets the pull request and the request as JSON on stdin; it has
10 seconds to exit: 0 lets the request through; anything else, an error or no answer refuses it,
with the first line the command wrote to stderr as the reason. It runs before a new review is
queued, for a request or for a push the polling finds; a request that joins a job or finds the
commit already reviewed does not ask it, and a refused push is not asked again until a new
commit.

### Recipes

- **Slack through your AI:** with a Slack MCP server and `phada mcp` in your AI CLI, ask it to
  watch a channel, call `review_pull_request` with `publish: none` for each pull request link,
  `wait_for_job`, and post the findings it gets back in the thread.
- **Teams, mail or anything with a webhook:** a `review.finished` hook that posts the event, e.g.
  `jq '{text: "\(.job.url): \(.verdict)"}' | curl -s -H 'Content-Type: application/json' -d @- "$TEAMS_WEBHOOK_URL"`.
- **A schedule:** `phada enqueue` from cron, as above.

## History

Every review is saved on your machine in `~/.local/share/phada/history.sqlite`
(`$XDG_DATA_HOME/phada` when set; `PHADA_DATA_HOME` to choose another folder): the reviews of the
watch, its queue and failures, and every `phada review`, including `--dry-run` and skipped runs.
Each run keeps the same JSON as `--format json`, without the diff; findings can still quote code,
so the file stays readable only by you. Unlike the cache, the history is never rebuilt or deleted
by Phada; a newer version updates it in place, and an older one refuses a file written by a newer
one instead of touching it. `history: false` in your own config turns it off (`phada watch`
needs it).

```bash
phada history                         # the last 50 reviews
phada history owner/repo --since 30d  # one repository, the last 30 days
phada history owner/repo#123          # one pull request, with what happened to each comment
phada history show 42                 # one run, with everything it sent and found
phada history --stats                 # what happened to the comments, per repository
phada history --refresh --stats       # read the comments on GitHub first
phada history prune --older-than 180d
```

Each review of the watch shows who asked for it: `watch` (the polling), `enqueue`, `mcp`,
`pr-command` or `slack`.

Each run of the list starts with its id, and `phada review` ends with it when it saves the run
(`Saved as run 42: phada history show 42`). `phada history show <id>` prints that run again with
the sections of `--dry-run`, read from the history: what was posted on the pull request (or would
have been), the findings close to the cut, the claims of the description, the context,
conversation and CI sent to the AI, the impact, the related repositories, the skills, what the
investigation read and the tokens. It starts with a line naming the run, the pull request, its
commit, when, who asked, the provider and model, and how it ended (published with the link, dry
run, skipped and why, failed and the error). A run saved by an older version shows the sections
it kept. `--format json` prints the run's history fields under `run` and its saved JSON under
`result`, with `schemaVersion: 1`.

### What happened to each comment

The history also keeps every comment Phada published and what happened to it, read from the
comment's thread on GitHub, without the AI. Each comment has one outcome:

- **fixed**: Phada resolved it after a recheck (see
  [Comments fixed in a new commit](#comments-fixed-in-a-new-commit)), or a person resolved it
  after the lines it points at changed;
- **dismissed**: a person resolved it without the lines changing;
- **ignored**: it was still open when the pull request was merged or closed;
- **open**: none of the above yet.

And two marks: **negative reaction** (a 👎 or 😕 on the comment) and **replied** (someone
answered in the thread; Phada's own replies and bots do not count). Outcomes and marks follow the
thread: a resolved comment that is reopened is open again, and a removed reaction stops counting.
The history keeps when each one started and, when it stopped, when.

`phada review` saves the state of the threads it reads on every run. `phada watch` also reads
the pull requests with Phada comments every 30 minutes when the queue is idle, and once more when
they are merged or closed. Without the watch, `phada history --refresh` reads them on demand
(it needs a GitHub token); `phada history owner/repo#123 --refresh` reads that pull request even
when the history has nothing about it yet.

`--stats` counts the comments published in the period per repository, with the share of each
outcome. They are signals, not verdicts: a dismissed comment may still have been right.

`--format json` prints the runs, the comments with their outcome and the history of each signal,
or the stats, with `schemaVersion: 1`. `phada history prune --older-than <age>` removes reviews,
comments and finished jobs older than that age (`1d` at least); it never touches what the watch
needs to know what it already saw.

## Rules and repository context

Besides the diff, every review gets context from the repository and from your own config. All
of it is read from the **base commit** of the pull request, so a pull request cannot change the
rules that review it.

- **Rules** from `.phada/` in the repository and from your own config (see
  [Configuration](#configuration)). They reach the AI as instructions: a change that breaks one
  is a finding that names the rule, and a rule can set the lowest severity of those findings.
- **Claude Code rules**: each `.claude/rules/**/*.md` file at the root is a rule too, named by its
  path (`.claude/rules/sql.md`). Its `paths:` front matter (one glob or a list, relative to the
  root) sets the files it applies to: it is sent when a changed file matches, and left out
  otherwise; a file without `paths:`, or whose front matter cannot be read (with a warning),
  applies to every file. Like the other rules they have no size budget: each one is sent whole,
  cut at 20 KB with a visible note and a warning. `disabledRules` turns one off by its path, and
  `context.defaults: false` stops reading them.
- **Docs** the AI reads as reference, in this order: the files your config lists; `README.md`,
  `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `.cursor/rules/*.mdc` in the folders of the changed
  files and above them; at the root, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`,
  `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`,
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
`Context at base a1b2c3d: 2 rules · 5 docs (21.3 KB, 1 omitted, 2 not applied) · 1 file ignored`,
naming the base commit the context was read from (the summary above it names the head), where
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

For a pull request it reads the base commit, as the review does, and says so in its title
(`Context for owner/repo#123 at base a1b2c3d`); it lists the config files, the rules with their origin, scope and whether they
apply, the docs and why each one was sent or left out, and the ignored files. For a repository it
lists every `.phada/` folder, the rules, the docs a review could read (in subfolders, only where
there is an `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or `.cursor/rules/`) with the scope of each
instruction file, and the ignore patterns. `--format json` prints the same with `schemaVersion: 1`
and the `context` block of `phada review --format json`. It needs a token that can read the
repository contents and never writes anything.

## Conversation and CI

The review and the verifier also get what people already said on the pull request and the
checks of its head. Both are written by others (the comments by whoever commented, the logs by
code the pull request can change), so they reach the AI as **untrusted data**, never as
instructions. They never change the score or the verdict: only findings do.

### The conversation

The general comments, the reviews and the review threads (file, line, resolved, outdated, with
their replies) of the pull request, oldest first, each with its author's role: the pull request
author, owner, member, collaborator, contributor, external or bot. Phada's own reviews and
comments are left out; a Phada comment someone replied to is kept as its title with the people's
replies, and a review without text only when it approves or requests changes. The AI does not
report again a problem raised in a thread that is still open or dismissed in a reply, weighs what
the author explains about a choice (a P0 or P1 problem is still reported however it was
explained), and reports an instruction aimed at reviewers or AI tools in a comment as a finding.

Each body is cut at 2 KB and the whole conversation fits in 16 KB; when it does not, resolved
threads are left out first, then outdated ones, then the oldest items. Phada prints
`Conversation: 6 comments (2 resolved, 1 bot)`, with `3 left out over 16 KB` and `1 cut at 2 KB`
when it had to. `conversation: false` or `--no-conversation` turns it off.

### The checks

The check runs and commit statuses of the head, or only those `ci.checks` names (names or globs,
e.g. `[test, "lint/*"]`). Each failing check is sent with its title, summary, failure and warning
annotations (50 in total) and, for GitHub Actions, the end of the step that failed in its log
(the last 8 KB of each, 12 KB for all logs); pending and passing checks only by name. What does
not fit is left out and counted. A failure caused by the diff is reported as a finding on the
line that causes it, even when a test caught it, citing the check (the comment says it is based
on the CI check `test`); a failure unrelated to the diff (a flaky test, the runner,
infrastructure, billing) or a pending check is not reported.

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
`Waiting for CI… 3m12s, 2 pending: test, build`; a failing check does not end the wait while
others are pending, no check 2 minutes after the start reviews at once, and it reviews even when
the checks fail. `ci.wait: 0s` does not wait,
`ci.read: false` in the config warns and reviews at once, and `--wait-ci` with `--no-ci` is an
error. [`phada watch`](#watch-mode) waits on its own, and can also skip commits whose checks fail.

## Review focus and skills

By default the AI reviews as Phada's built-in reviewer: a senior engineer looking for bugs,
security issues, data loss, performance problems and risky design, leaving out style nitpicks and
what a linter or a test run would catch. You can change what it looks for, or have the review
follow review skills you already use with your AI CLI. Whatever the focus, the output format,
the line numbers, the confidence and severity scales and the rules about untrusted data stay
Phada's, so every finding is still checked against the diff, verified and scored the same way.

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

- **`review.prompt`** changes the built-in reviewer: `append` adds the text of the file as an
  extra focus, `replace` uses it instead of the built-in role, scope and list of what not to
  report. It is read like the rules: from the base commit for the repository's config, from your
  disk for your own. A missing or empty file stops the review before the AI is called.
- **`review.skills`** runs one review pass per skill, in order, and publishes one review with the
  findings of every pass; a finding two passes report on the same line with the same title is
  kept once. Each finding names the skill that found it in the terminal, the JSON and the history;
  on the pull request the skill is only in the hidden marker of the comment. `phada` is the built-in reviewer, with your `review.prompt` if there is one;
  leave it out to review only with your skills. `paths` runs a skill only when a changed file
  matches; otherwise the pass is skipped and the review says so. When no pass runs, nothing is
  published and Phada says which skills did not apply. A pass whose answer is not a valid review
  is left out with a warning and the others still publish; a provider failure (a usage or rate
  limit, a timeout) fails the whole review, so it can run again later.
- **`--skill <name>`** (repeatable) replaces the configured list for one run of `phada review` or
  `phada prompt`. `phada watch` uses only the config.

Phada looks for a skill where the AI CLIs install them: your Claude Code skills
(`~/.claude/skills/<name>/SKILL.md`) and commands (`~/.claude/commands/<name>.md`), the skills
and commands of your installed Claude Code plugins, and the skills of Codex
(`~/.codex/skills/`) and `~/.agents/skills/` (`$CLAUDE_CONFIG_DIR` and `$CODEX_HOME` are
followed). A plain name finds your own skill first, then the only plugin that has it; when
several plugins have a skill with that name, use `plugin:skill`. A skill you ask for that is not
installed stops the review before the AI is called and names the folders Phada looked in; one the
repository's config asks for is skipped with a warning.

With Codex and Ollama, or for a skill with `mode: text`, the skill's text is sent as the
reviewer's guide, without its front matter and with the `.md` files of its folder that it names, up to 32 KB per skill (cited files that do not
fit are left out with a warning). The AI follows what the guide asks it to look for and to leave
out; steps that fetch the pull request, post on it, ask you something or hand work to other
agents are left to Phada, and the AI reads history, blame and other files with the
[investigation tools](#repository-investigation). The verifier sees the guide each finding came
from, so it does not reject a finding the guide asks for as a matter of style.

With several skills each pass takes about as long as a review, and the stderr lines
`Skills: …` and `Skill 2/3: …` show where it is. `--dry-run` ends with a section that lists
each pass with its findings, time and tokens; the JSON has `skill` on every finding and a
`passes` block (`null` when only the built-in reviewer ran without a custom prompt).

### Skills that run natively

With Claude Code, every skill you name except `phada` runs as `/<name>`, the way it runs in your
terminal, in a temporary checkout of the pull request head:

- **The change is where a skill expects it.** The base branch is `origin/<base>`, pointing at
  where the pull request branched off, so `git diff origin/<base>...HEAD`,
  `git log origin/<base>..HEAD` and `git merge-base` show the pull request; the diff is also in
  `.git/pull-request.diff` inside the checkout. Symlinks of the pull request are checked out as
  plain files.
- **So is what the review knows.** Next to the diff, `.git/conversation.jsonl` has the
  [conversation](#the-conversation), `.git/ci.md` the [checks](#the-checks) and `.git/impact.md`
  the [impact](#repository-graph) of the change and the
  [related repositories](#related-repositories), as the review's prompt has them; each file is
  there only when it has something, and the skill's first message names them (the conversation
  and the checks as data, never instructions).
- **What it can do.** Read and search files, run subagents, use Phada's
  [investigation tools](#repository-investigation) and the MCP servers your config names in
  `mcp`. Bash runs only git reads (`diff`, `log`, `show`, `blame`, `status`, `rev-parse`,
  `merge-base`, `ls-files`, `grep`) and `gh`, unless `review.commands` allows more. It cannot
  write files or use the web, and it reads only inside the checkout, its own folder and
  `review.readDirs`. The repository's own `.claude/` settings and `CLAUDE.md` are not loaded.
  `git` options that could run a program, write a file or read outside the checkout (such as
  `grep -O`, `--output`, `--no-index`, `blame --contents`, `-c` or `-C`) are refused.
- **`gh` is answered by Phada.** `gh pr view` and `gh pr diff` come from the data Phada already
  fetched; the pull request shows as open and not a draft, without the reviews and comments of the
  token's owner. `gh pr checks` answers from the checks Phada read (the ones that count),
  tab-separated or with `--json` and `--jq`, with the exit codes of `gh` (1 when one fails, 8 when
  one is pending); `--watch` answers at once. Other reads of the same repository (`gh pr list`, `gh issue view`,
  `gh issue list`, `gh search prs`, `gh search issues`, `gh repo view`, and `gh api` GET of the
  repository and its pulls, issues, commits, compare, contents, git, branches, labels,
  milestones, releases, tags, contributors, languages and readme) go through Phada with its
  token, up to 60 per pass; searches only ever look in that repository, and settings, secrets,
  alerts, webhooks and Actions are never read. `gh pr comment`,
  `gh pr review` and `gh api` posts of comments or reviews on this pull request are kept as the
  skill's output and **never sent**. Anything else fails with a message that lists what works;
  `--jq` takes paths like `.files[].path`.
- **Nothing leaks.** No GitHub token reaches the AI CLI, and the checkout and its folder are
  removed after the review, also on errors and Ctrl-C.
- **The output becomes a Phada review.** When the skill finishes, one more call to the same model
  turns what it tried to post (or else its final answer) into findings, in the skill's words, and
  the review goes on as usual: line checks, duplicates, verification, cut and score. The summary
  is the skill's. When none of its findings points at a changed line, the skill's output becomes
  the body of the review. `--dry-run` shows the skill's output and the JSON has it in
  `passes[].output`.
- **Text mode and built-in skills.** `{ name: my-plugin:review, mode: text }` sends a skill as
  text instead; `claude:<name>` names a skill built into Claude Code, which only runs natively.
- **Time.** A native pass can take many minutes, and skills that start several subagents use many
  tokens. `review.timeout` (default `30m`) limits each pass; one that runs out fails the review,
  and `phada watch` tries it again later like other timeouts.

```yaml
# ~/.config/phada/config.yml
review:
  commands: read-only # the default; or a list like ["npm test"]; or all
  readDirs: ['~/review-rules'] # folders a skill may read besides the checkout
  timeout: 30m
```

`review.commands`, `review.readDirs` and `review.timeout` are only read from your own config,
never from a repository's `.phada/`. A list or `all` lets the skill run those commands, and they
run the code of the pull request on your machine: allow them only for repositories you trust.
A pull request of a public repository from an author who is not an owner, member or collaborator
always runs read-only, without `readDirs`. Every command or read the skill was refused is shown
on stderr, in `--dry-run` and in the JSON (`passes[].blocked`) with the line that allows it:

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
phada prompt --default                          # the built-in prompt, no token needed
```

For each pass it prints every part of the instructions with where it comes from (`phada`, the
`review.prompt` file, the skill's file, the rules) and the size of the data blocks (the pull
request, the docs, the [conversation](#the-conversation), the [checks](#the-checks) and the
diff); the conversation and the checks are read unless the config turns them off. A native pass shows the message the skill gets, the context
Phada adds, the commands and folders it may use, and the instructions that turn its output into
findings. The tool sections are shown as a review sends them when the
repository index is ready; the impact of the change and related repositories are computed during
a review and are not shown. `--format json` prints the same with `schemaVersion: 1`.

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
too, with its own budget. The review pass is also asked for a minimum number of calls that grows
with the diff: one for every 10 KB of the diff after ignored files, at least 3 and at most 15. When
the diff changes CI workflows, container files, infrastructure code (Terraform, deploy and
Kubernetes configs) or package manifests, the AI is told to check what each of them affects. What the tools return comes from the pull request head, written by its
author, so it is data for the AI, never instructions. Findings still point to a line of the diff,
and the files the AI read to support them show up in their sources. The mirror stays for the
next review of the repository, which then fetches only what changed.

Claude Code and Codex reach the tools through a local MCP server that Phada runs for the review;
their own tools stay off. Ollama models use tool calling; a model that does not support it
reviews without the investigation, with a warning.

After the review Phada prints what the AI read, e.g. `Investigated: 6 reads, 3 searches (41.2 KB)`.
A pass that made fewer calls than its minimum gets a warning, e.g. `Investigated 4 times for a
124 KB diff (expected at least 12).`; the review is not run again.
With `--dry-run` the preview lists every call, the minimum and the passes that fell short, and the
JSON has an `investigation` block with each call, its size and whether a finding used it, and
`floor` with the minimum (`expected`) and those warnings (`shortfalls`). `--no-investigate` (or `investigate: false`)
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

### MCP servers

Your own config can give the AI MCP servers to read from during the review, for example the
ticket a pull request refers to. A server is either **named**, as your AI CLI already knows it,
or **declared** in Phada's config, for any provider:

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

- **Named servers** run inside your AI CLI. With Claude Code, any server it has (`claude mcp
list`; claude.ai connectors as `claude.ai <Name>`). With Codex, Phada reads the server with
  `codex mcp get <name> --json` and passes it to the run, keeping header and environment values
  off the command line. Every tool of a named server is allowed unless `tools` lists the ones
  to allow. Ollama has no servers of its own: declare them instead. A name your AI CLI does not
  know, or a server disabled in Codex, stops the command before the review.
- **Declared servers** are started (`command`, `args`, `env`) or reached over streamable HTTP
  (`url`, `headers`) by Phada itself, which offers their tools to the AI next to the
  [investigation tools](#repository-investigation), with Claude Code, Codex and Ollama alike, in
  the same budget of calls and bytes. Only the tools a server marks as read-only are offered;
  `tools` lists exactly the ones to allow instead, write tools included, at your own risk. A
  server that does not start or refuses the credentials is reported and the review goes on
  without it. HTTP servers that need an OAuth login are not supported: name them in your AI CLI.
- **Secrets** come from environment variables: `${NAME}` in `env`, `headers`, `args` and `url`,
  whole or inside a value (`Bearer ${DOCS_TOKEN}`). A value that looks like a secret written
  in the file (a token, or any value of a key such as `Authorization`, `*_TOKEN` or `*_KEY`) is
  refused when the config is read, and a variable that is not set stops the command before the
  review. A declared server gets your environment without the GitHub token, plus its `env`.
  The value of a variable used for a secret (a key or variable such as `Authorization`,
  `*_TOKEN` or `*_KEY`, or a value shaped like a token) is replaced with `[REDACTED]` in what the
  server answers and in its error messages; other values, such as `${HOME}`, are left as they are.
- `description` tells the AI what a server is for; it is added to the prompt only when a server
  is configured.

Servers are read only from your own config (never from the repository's `.phada/`), only while
the [investigation](#repository-investigation) runs, and never for a pull request of a public
repository from an outside author (not an owner, member or collaborator): Phada reviews those
without any of your servers and says so. Calls count in the `Investigated:` line
(`· 3 MCP calls (tickets, linear)`), `--dry-run` lists each call and each server with its state
and the tools it hid, and the JSON has them in `investigation.calls[].server` and
`investigation.mcp`. A finding based on a server cites it as `<server>: <what it read>`. On a
public repository Phada warns that what the AI read there may end up in the published review.

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
Existing files are never overwritten. [`phada setup`](#setup) and the app write `provider`,
`model`, `language` and `watch.repos` in your own config for you (see
[Changing your config from the app](#changing-your-config-from-the-app)).

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
conversation: true
ci:
  read: true
  wait: 15m
  onFailure: review
  checks: [test, 'lint/*']
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
| `resolveThreads`          | `false` turns off the [recheck of earlier comments](#comments-fixed-in-a-new-commit), like `--no-resolve`                                    | both (root)             |
| `mcp`                     | MCP servers the AI may use: names from your AI CLI or servers declared with `command` or `url` (see [MCP servers](#mcp-servers))             | your config             |
| `context.defaults`        | `false` sends only the files listed in `context.files`, not the docs Phada picks nor the `.claude/rules`                                     | both (root)             |
| `context.files`           | Files of the repository to always send (globs allowed), first in line for the budget                                                         | both                    |
| `context.repos`           | Other repositories the review may read (see [Related repositories](#related-repositories))                                                   | both (root)             |
| `context.privateOnPublic` | `true` lets a private related repository be read for a public pull request                                                                   | your config             |
| `conversation`            | `false` keeps the [conversation](#the-conversation) away from the AI, like `--no-conversation`                                               | both (root)             |
| `ci.read`                 | `false` turns the [checks](#the-checks) off, like `--no-ci`                                                                                  | both (root)             |
| `ci.wait`                 | How long the watch and `--wait-ci` wait for pending checks (default `15m`, `0s` does not wait)                                               | both (root)             |
| `ci.onFailure`            | `review` (default) or `skip`: the watch skips a commit whose checks fail until they pass (see [Watch mode](#watch-mode))                     | both (root)             |
| `ci.checks`               | The checks that count, by name or glob (default: all)                                                                                        | both (root)             |
| `ignore`                  | More files to leave out of the diff                                                                                                          | both                    |
| `rules`                   | Rules with `rule`, and optionally `id`, `scope` (globs) and `severity` (`P0`, `P1` or `P2`)                                                  | both                    |
| `review.debt`             | `summary` (default), `comments` or `off`: what to do with the [repository debt](#repository-debt)                                            | both (root)             |
| `review.prompt`           | `file` and `mode` (`append` or `replace`) of the reviewer's focus (see [Review focus and skills](#review-focus-and-skills))                  | both (root)             |
| `review.skills`           | Skills to review with, one pass each, as names or `{ name, paths, mode }`; `phada` is the built-in reviewer                                  | both (root)             |
| `review.commands`         | Commands a [native skill](#skills-that-run-natively) may run: `read-only` (default), a list like `["npm test"]`, or `all`                    | your config             |
| `review.readDirs`         | Folders a native skill may read besides the checkout and its own folder                                                                      | your config             |
| `review.timeout`          | How long one native skill pass may run (`1m` to `2h`, default `30m`)                                                                         | your config             |
| `watch`                   | Repositories `phada watch` follows and how (see [Watch mode](#watch-mode)), and their `when` command                                         | your config (top level) |
| `hooks`                   | Commands that get the [review events](#review-events-and-hooks)                                                                              | your config (top level) |
| `slack`                   | Slack channels the watch listens to (see [Slack](#slack))                                                                                    | your config (top level) |
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

| Option                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--provider <name>`    | AI provider: `claude` (default, unless your config sets one), `codex` or `ollama`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--model <name>`       | Model to use. Required for Ollama. Default: for Claude, the Claude Code default model, else `opus`; for Codex, the `model` in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), else the Codex CLI default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--language <tag>`     | Language of the review, e.g. `pt-BR`. The AI writes its text in it, and Phada's own headings and labels follow it in English (`en`), Portuguese (`pt`, `pt-BR`) and Spanish (`es`, `es-MX`, …); other languages keep those labels in English. Default: English                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--min-confidence <n>` | Confidence cut, a whole number from 50 to 100. Findings at the cut or above are shown and scored; the ones from 50 up to the cut are listed as worth checking. Default: 60                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--format <name>`      | Output: `markdown` (default) or `json`. The JSON (`schemaVersion: 1`) carries the same review as data: the [verdict](#review-events-and-hooks), score, summary, every changed file, findings (each with its `scope`), the repository `debt`, findings worth checking, dropped counts, the verification (unless `--no-verify`), provider, model, time and tokens, a `publication` block (`published` with the URL, `failed`, `dry-run` with the exact body and comments, or `skipped`; with the number of findings `stillOpen` and `dismissed`), a `context` block (see [Rules and repository context](#rules-and-repository-context)), `conversation` and `ci` blocks (see [Conversation and CI](#conversation-and-ci)), an `investigation` block (see [Repository investigation](#repository-investigation)) and an `impact` block (see [Repository graph](#repository-graph)) |
| `--no-investigate`     | Reviews without letting the AI read the rest of the repository (see [Repository investigation](#repository-investigation)); `--investigate` turns it back on when the config turns it off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--verify`             | Checks every finding with a second call to the AI before scoring (see above). On by default; `--no-verify` (or `verify: false`) turns it off, `--verify` turns it back on when the config turns it off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--no-resolve`         | Neither rechecks Phada's comments from earlier commits nor resolves the fixed ones (see [Comments fixed in a new commit](#comments-fixed-in-a-new-commit)); same as `resolveThreads: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--no-conversation`    | Does not send the comments, reviews and threads of the pull request to the AI (see [The conversation](#the-conversation)); same as `conversation: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--no-ci`              | Does not read the checks of the head: no CI for the AI and no CI line in the review (see [The checks](#the-checks)); same as `ci.read: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--wait-ci`            | Before reviewing, waits for the pending checks of the head for at most `ci.wait` (default 15 minutes) since the command started (see [Waiting for the checks](#waiting-for-the-checks))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--skill <name>`       | Reviews with this skill, one pass each when repeated; replaces `review.skills` (see [Review focus and skills](#review-focus-and-skills))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--dry-run`            | Prints exactly what would be published (the review body and every comment) and posts nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--force`              | Reviews and publishes even when Phada already reviewed this commit (see [Publishing](#publishing))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--debug`              | Shows error details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Exit codes

| Code | Meaning                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | The review was published (or printed with `--dry-run`), Phada skipped a commit it already reviewed, or the pull request has no changes to review (or only ignored files) |
| 1    | Something failed: GitHub, the AI provider, an answer that is not a review, or publishing (the review is printed first)                                                   |
| 2    | The command line or your own config is wrong (unknown option, invalid pull request reference, invalid `config.yml`, a skill that is not installed, …)                    |

`phada index` exits with 0 when the map was built and 1 when fetching or writing it failed.
`phada rules` exits with 0 when it printed the context and 1 when GitHub could not be read.
`phada prompt` exits with 0 when it printed the prompt, 1 when GitHub could not be read and 2
when a skill or the `review.prompt` file is missing.
`phada history` exits with 0 when it printed the history and 1 when the file or, with `--refresh`,
GitHub could not be read; `phada history show` exits with 1 when the history has no run with that
id.
`phada enqueue` exits with 0 when the request was queued or joined a job, 1 when it was refused
or GitHub could not be read, and 2 when the command line or your config is wrong.
`phada mcp` exits with 0 when its input ends.
`phada` with no command and `phada setup` exit with 0 when you quit the app, 130 on Ctrl-C, 143
on `SIGTERM`, 1 when it failed and 2 outside a terminal.
`phada watch` exits with 0 when it stopped or `--once` finished, 1 when it stopped on an error
(another watch running, an AI CLI that is not logged in, a token GitHub rejects), 2 when the
command line or your config is wrong, and 130 when a second Ctrl-C aborted it.

## What the AI sees

With Claude Code and Codex, the AI runs in an empty temporary directory (a
[native skill](#skills-that-run-natively) runs in a checkout of the pull request instead) and
only sees the text that Phada sends: the pull request, its diff, the rules and docs described in
[Rules and repository context](#rules-and-repository-context), its
[conversation and checks](#conversation-and-ci), and what it reads with Phada's
tools from the pull request head and from the [related repositories](#related-repositories) (see [Repository investigation](#repository-investigation)). Rules from `.phada/` and your
config are instructions, and so are the `review.prompt` file and the text of the skills you
name (see [Review focus and skills](#review-focus-and-skills)); the pull request, the diff, the
docs, the conversation and the checks are data, and instructions hidden in them are reported as findings. Phada only reads the `model` from their settings. An
`AGENTS.md`/`CLAUDE.md` in or above that temporary directory is never loaded, and the GitHub
token is removed from the environment of the AI process.

Claude Code runs without its own tools or your personal settings (hooks, plugins, skills,
`CLAUDE.md`). A skill named in `review.skills` runs natively in a checkout of the pull request
with only that skill or plugin loaded and the limits described in
[Skills that run natively](#skills-that-run-natively). The only MCP servers it can use are
Phada's (which also carries the servers declared in `mcp`) and the ones `mcp` names.

Codex keeps a few built-in tools enabled that, with Codex CLI 0.160.0, can neither read your
files nor reach the network. Phada also turns off the apps connected to your ChatGPT account,
the shell, web search, plugins and sub-agents, and runs it read-only. Codex adds features
between versions, so the list of disabled features was checked with that version. Codex also
still reads your global `~/.codex/AGENTS.md` (or `$CODEX_HOME/AGENTS.md`) on every review, so
keep it free of instructions you do not want applied to your reviews. Your own MCP servers stay
off unless `mcp` names them (see [MCP servers](#mcp-servers)).

### Local models with Ollama

```bash
ollama pull qwen2.5-coder:7b
phada review owner/repo#123 --provider ollama --model qwen2.5-coder:7b
```

The [setup](#setup) and the Provider screen of the app can pull the model and choose it for you.
Phada talks to Ollama at `127.0.0.1:11434` (or `OLLAMA_HOST`). It checks the model's context
window first and stops with an error when the pull request does not fit: it never lets the
model silently cut the diff. When the prompt carries the conversation or the checks, the error
also suggests leaving them out with `--no-conversation` or `--no-ci`.

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
- Tokens are read from environment variables or the `gh` login and are never saved or printed. Phada never reads or
  manages the credentials of your AI CLI: authentication belongs to that tool.
- Phada is licensed under the [Apache License 2.0](LICENSE).
