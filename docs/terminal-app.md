# The terminal app

`phada` with no command, in a terminal, opens an app that shows what Phada has set up, running and
reviewed, in one place, without remembering commands or folders. This page covers its screens and
keys, what it reads and writes, the step-by-step setup, and how to review a pull request, run the
watch and change your config from it. It runs the same reviews, watch and config changes as the
[commands](commands.md#commands).

## Terminal app

Run `phada` with no command in a terminal to open the app: what Phada has set up, running and
reviewed, and the [setup](#setup) and the [changes to your config](#changing-your-config-from-the-app)
you would otherwise write by hand. It opens on the terminal's alternate screen, like `less` or
`vim`, and the terminal is back as it was when you quit.

```bash
phada
```

### Screens

- **Home**: one line each for GitHub (where the token comes from and whose it is), the AI
  (installed and logged in), the watch, the queue and the repository maps; the last reviews; and
  what to do next, with the command.
- **Repositories**: the watched repositories, the ones with a config of their own and the ones in
  the history → the settings of each with where every value comes from, its watch filters, its
  map, its related repositories and its last reviews (and, for a watched one, whether it
  publishes). `w`, `p`, `a`, `e` and `R` change them, `i` indexes it, `v` reviews one of its open
  pull requests.
- **Rules**: the reviewer lens and your rules at once; the repository's `.phada/` and the rules
  and docs a review of the default branch reads. `p` and a pull request number show what a review
  of it reads and its prompt (see
  [Rules and repository context](review-context.md#rules-and-repository-context)).
- **Reviews**: the [history](history-and-lessons.md#history), with `f` to filter → one review with
  its score, findings, what was published, the CI line and what happened to each comment. `n`
  reviews a pull request.
- **Queue**: the watch running in this app, in another terminal (with its PID) or not running, its
  last and next cycle, the job running (with the step of its review when the watch runs here), the
  jobs queued, waiting for CI, skipped for failing CI or failed, a pause, the reviews this hour and
  the log of the watch started here → a job with its requests. `w` starts or stops the watch, `l`
  opens its whole log.
- **Automation**: the watch, the CI wait, the request sources that are on (pull request comments,
  `phada enqueue`, `phada mcp`, Slack), the hooks and the `when` commands (see
  [Watch and review requests](watch-and-requests.md#watch-mode)).
- **Provider**: the provider and model you chose and where they come from, the language, each AI
  checked (installed, logged in, Ollama running and its models) with the command that fixes it,
  and your MCP servers. `c`, `L` and `l` change them.
- **Graph**: the [map](configuration.md#repository-map) of each repository of the Repositories
  screen: whether it is indexed, its commit, files, symbols and size → its commit and branch, when
  it was indexed and how long it took, its files per language, its symbols by kind, its imports,
  exports, calls and uses, and the files left out and why, and its connections: each related
  repository it declares (`context.repos`) linked by the packages one publishes and the other uses,
  without a link, or not indexed and why. `i` indexes it and `I` the related ones not indexed; `s`
  explores a symbol.
- **Learnings**: per repository, the relations learned from reviews, what happened to Phada's
  comments, per repository and per rule, the open [misses](history-and-lessons.md#misses) with how
  many the latest replay caught, and the pending [lessons](history-and-lessons.md#lessons) to
  accept or discard. On an open repository, `l` goes to its pending lessons, `a` accepts the
  selected one and `d` discards it; the app shows the file and the rule it would write, and `Enter`
  confirms while `Esc` cancels.

### Keys

- `←`/`→` or `Tab` move between screens, and `1`–`9` jump to one.
- `/` finds a screen by name in a palette, and also opens `/setup` (the setup), `/language` (the
  language), `/index` (the Graph), `/review` (a review) and `/watch` (starts or stops the watch).
- `?` lists every key.
- `↑`/`↓` and `Enter` open an item, and `Esc` goes back; on a screen with nothing to go back to,
  `Esc` quits like `q`.
- `r` reads again what comes from GitHub or the AI CLIs.
- `q` quits.

The footer lists the keys of the screen you are on.

### What the app reads and writes

What is on your machine (the config, the history, the queue) is read every 2 seconds; what comes
from GitHub or the AI CLIs is read when a screen opens and on `r`. The app writes only what
[Changing your config from the app](#changing-your-config-from-the-app) lists, and the history only
for a review or the watch you run from it, as `phada review` and `phada watch` do (just reading it
never creates its file).

It reads each map without changing it: a map that is missing, made by another version of Phada or
that cannot be read is shown as such on the Graph screen, until you index it. The connections of
the Graph come only from your machine: the manifests and the `.phada/config.yml` of the indexed
commit, read from the local copy the index was built from, never fetched.

It needs a terminal of at least 80×24 and says so when it is smaller. It follows the `language` of
your config (English, Portuguese and Spanish), uses the full colors your terminal supports (down to
16), and none with `NO_COLOR` or `TERM=dumb`. `q` exits with 0, Ctrl-C with 130 and `SIGTERM` with 143. Outside a terminal (a pipe, a script), `phada` with no command prints the same error as
before, and `phada setup` stops with a usage error.

## Setup

`phada setup` opens the app on the setup; `phada` alone opens it while your own `config.yml` does
not exist, and `/setup` opens it from any screen, from its first step. It has seven steps, shown as
`Step n of 7`: `s` skips one, and `Esc` asks whether to leave the setup for the Home (`y` or
`Enter` leaves, `n` or `Esc` stays; what you confirmed is already written, and `phada setup` starts
again).

1. **GitHub**: where the token comes from (`GITHUB_TOKEN`, `GH_TOKEN` or the `gh` login) and whose
   it is. Without a token, or when GitHub refuses the token of the `gh` login, `Enter` hands the
   terminal to `gh auth login` and checks again when it ends. Without `gh`, it says how to install
   it or to export `GITHUB_TOKEN`; a token from a variable that GitHub refuses has to be replaced or
   unset.
2. **AI**: Claude Code, Codex and Ollama, each checked (installed, logged in, running), and `r`
   checks again. Choosing a CLI that is not logged in hands the terminal to its login
   (`claude auth login`, `codex login`) and checks again when it ends; the credentials stay with
   the CLI. A CLI reviews with its own default model or one you type. When Ollama is not running,
   the step says to start it with `ollama serve` and press `r`; when it runs, you pick an installed
   model, type one, or take the suggested `qwen2.5-coder:7b` (about 4.7 GB). A model Ollama does
   not have is pulled through its API (at `OLLAMA_HOST` too), with its progress, and `Esc` cancels
   the pull.
3. **Language**: English, Portuguese or Spanish, for the app and the reviews; the app speaks it at
   once.
4. **Repositories**: the repositories of the token owner on GitHub (owned, as a collaborator and of
   your organizations, without the archived ones, most recently pushed first), with the ones
   already in `watch.repos` marked and first. `f` filters the list, `Space` marks or unmarks one,
   `a` adds an `owner/repo` that is not listed, and `Enter` saves the marked ones to `watch.repos`.
5. **Graph**: builds the [map](configuration.md#repository-map) of each watched repository, one at
   a time, with `N of M files`. `Esc` stops: what was extracted is kept, and `phada watch` finishes
   it when it is idle, or `phada index owner/repo` now.
6. **This repository**: when the app runs inside a git repository without a `.phada/` folder,
   `Enter` runs `phada init` there and lists the files it created.
7. **Summary**: what was written and to which file, what was indexed or left for later, what
   `phada init` created, the steps skipped, and what to run now (`phada watch` when a repository is
   watched, `phada review owner/repo#N`).

A step that changes your config shows the change first, one line per value
(`provider claude → codex`, `watch.repos + owner/repo`), and writes it only on `Enter`; `Esc`
cancels it.

## Reviewing a pull request from the app

`/review` in the palette, `n` on the Reviews screen or `v` on a repository of the Repositories
screen open the review in place of the tabs:

1. **The pull request**: type `owner/repo#N` or its URL and `Enter` (anything else is refused on the
   spot), or pick a repository (`Esc` leaves the field, `t` types again) → its open pull requests
   from GitHub, with their number, title, author and whether they are drafts (`r` reads them
   again). `v` opens straight on the open pull requests of that repository.
2. **The mode**: **Only look** reviews here and posts nothing, as `phada review --dry-run`;
   **Review and publish** posts the review on the pull request. While a `phada watch` runs (in the
   app or in another terminal), it becomes **Put in the queue**: the watch reviews and publishes it,
   as `phada enqueue owner/repo#N --publish pr`, and the result is the new job, the job it joined or
   why the queue refused it, with `Enter` to the Queue. Only look still runs here.
3. **For publishing**, the pull request and the GitHub login that will publish it (the owner of the
   token) to confirm: `Enter` publishes, `Esc` goes back. Without a token it does not offer to
   publish.
4. **The steps, live**: the pull request fetched (with a note under it when it is closed or a
   draft, which it still reviews, as `phada review` does), the context, the conversation, the CI,
   the indexing (`N of M files`), the related repositories, the impact, each run of the AI (review,
   verify, recheck, skill) with its time, publishing, and the warnings. `Esc` asks before cancelling
   (`Enter` cancels, `Esc` keeps it running): Phada stops the AI CLI (or the request to Ollama),
   posts nothing and saves nothing in the history. Once it publishes, it no longer cancels.
5. **The result**: the same detail as the Reviews screen (score, verdict, findings with their text,
   what was published or, for only look, that nothing was posted, what it would resolve or why it
   would skip, the CI), how long it took and whether the history kept it. A failed review shows its
   error; with `phada --debug`, also its causes and stack. `Esc` goes back to the screen you came
   from.
6. **Publishing what you looked at**: on the result of only look, `p` asks to publish that exact
   review (the pull request, the GitHub login and how many line comments and repository debt items
   it posts) and `Enter` publishes it without running the AI again, as
   [`phada publish`](publishing.md#look-first-publish-later). It shows the link, or why it did not
   publish (the pull request moved since the review, or Phada already reviewed that commit), and
   `Esc` goes back to the result, which no longer offers `p` once it is published. It needs the run
   in the history: with `history: false` it is not offered. It also publishes while a watch runs,
   since no new review starts.

It is the same review as `phada review owner/repo#N` (with `--dry-run` for only look): the
provider, model and MCP servers of your config for that repository, your GitHub token, and the run
saved in the history unless `history: false`. The AI CLI runs in its own process group, so it never
writes on the app.

`Esc` goes one step back; the palette stays closed while the review is open, so it is left only
with `Esc`. While a review runs, `q` and `Ctrl-C` ask before quitting (`Enter` cancels it and quits,
waiting for a publication under way; `Esc` stays; a second `Ctrl-C` cancels and quits at once).

## Running the watch from the app

`w` on the Queue screen, or `/watch` in the palette from any screen, starts the watch in the app:
the same watch as [`phada watch`](watch-and-requests.md#watch-mode) (your `watch:` settings, the
lock, the history, the hooks and Slack), until you stop it. The Queue says whether the watch runs
in this app, in another terminal (with its PID; `w` then only says so) or not at all, and what kept
it from starting, in one line.

Under the jobs, its log: what it queued, started, published, skipped or retried, its warnings, the
time of each line, and the step of the review under way on the running job; `l` opens the last 200
lines.

With the watch running here, `w` (or `/watch`) asks before stopping it after the current review;
`Enter` stops, `Esc` keeps it running. Quitting with `q`, `Esc` or `Ctrl-C` asks too: `Enter` lets
the current review finish and quits, a second `Ctrl-C` stops the AI at once and puts the pull
request back in the queue, and a `SIGTERM` does that without asking. A review you start from the
app while the watch runs here (only look) has its own AI CLI: cancelling one never stops the other.

## Changing your config from the app

- **Provider**: `c` changes the AI and its model (the choice of the setup's AI step, with the login
  or the model pull there), `L` changes the language and `l` logs in to the chosen AI CLI again (or
  to one that is not logged in). `/language` changes the language from any screen.
- **Graph** and **Repositories**: `i` indexes the selected (or open) repository, or indexes it
  again, with `N of M files` as it goes; `Esc` stops it, and the screen reads the map again when it
  ends. Leaving the screen stops it too. On an open repository of the Graph, `I` indexes the related
  repositories it declares that are not indexed yet.
- **Graph**: on an open repository, `s` asks for a symbol name and searches the
  [graph](review-context.md#repository-graph) the review uses, linked to the related repositories
  it declares that are indexed and linked by package. Several definitions are listed to pick one;
  one opens as a tree with its callers and its dependencies: `Enter` or `→` opens a node one level
  (a caller into its own callers, a dependency into its own dependencies, across the linked
  repositories), `←` closes it, and `Tab` moves between screens meanwhile. Each level shows 20
  items and how many more, and says when the graph cut the list short. A name not found or a
  repository that is not indexed says so, with `i` to index it. Everything is read from your
  machine; the app keeps the graph of one repository open at a time.
- **Repositories**: on the selected repository, `w` watches or unwatches it, `p` turns its
  `publish` on or off, `a` adds repositories from your GitHub list or typed, and `e` and `R` open
  its own `repos/<owner>/<repo>/config.yml` and `rules.md` (in your config folder) in `$VISUAL`,
  `$EDITOR` or `vi`, created with a commented header when they do not exist. The app is back when
  the editor exits, with the file read again.
- **Learnings**: `a` and `d` accept or discard a pending lesson, as
  [`phada lessons accept` and `discard`](history-and-lessons.md#accepting-a-lesson) do.

Like the setup, each change shows what it does before → after and is written only on `Enter`. The
app writes:

- your own `config.yml`: `provider`, `model`, `language` and `watch.repos` (a new file gets the
  values on top and the commented template of `phada init --global` below them);
- the `repos/<owner>/<repo>/config.yml` and `rules.md` you open in the editor, created when they do
  not exist and never overwritten;
- the [map](configuration.md#repository-map) of a repository when you index it in the setup or
  with `i` on the Graph and Repositories screens, in the cache, as `phada index` does (on its
  default branch, replacing a map made by another version of Phada or that cannot be read);
- a repository's `.phada/` only through `phada init`, in the setup's step 6;
- the [history](history-and-lessons.md#history), with a review or the watch you run from the app,
  as `phada review` and `phada watch` do (the watch also takes its lock and keeps the index of each
  default branch up to date);
- the history and the `repos/<owner>/<repo>/config.yml` of your own config when you accept or
  discard a lesson on the Learnings screen, as `phada lessons accept` and `discard` do.

Comments, the order of the keys and the lines a change does not touch stay as you wrote them. When a
line cannot be kept as written (an indentation of 4 spaces, for example), the change says that the
file is rewritten in a standard layout before you confirm it. The new text is checked like any
config before it is written, and it is written atomically (a temporary file renamed over it); a
symbolic link stays a link, and the file it points to changes. A config file that is already
invalid is never edited: the app shows its error and offers no change. If the file changed after
the change was shown, `Enter` shows it again.

While a login or the editor runs, the terminal is theirs and Ctrl-C goes to them, not to the app.
The login of an AI CLI runs without `GITHUB_TOKEN` and `GH_TOKEN` in its environment.
