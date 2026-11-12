# Commands

How to run Phada from the command line: reviewing a pull request or the branch you are on,
fixing the findings, answering replies, the GitHub token, the options of `phada review` and the
exit codes of every command. The commands whose detail lives on another page get a short
section here with a link to it.

> **Phada publishes by default.** `phada review` posts the review on the pull request as the
> owner of the GitHub token. Use `--dry-run` to only print it.

## Usage

```bash
phada review owner/repo#123
phada review https://github.com/owner/repo/pull/123 --provider codex
phada review                                    # the branch you are on, before the pull request
```

To run it without installing:

```bash
npx phada review owner/repo#123
```

Progress goes to stderr and the review to stdout, so `phada review owner/repo#123 > review.md`
saves only the review, and `--format json` prints it as JSON for scripts. A review of a large pull
request can take a few minutes. `phada review owner/repo#123 --dry-run` prints exactly what would
be posted and posts nothing; `phada publish <id>` then posts exactly that, without running the AI
again (see [Look first, publish later](publishing.md#look-first-publish-later)).

`phada --help` lists the commands, and `phada <command> --help` lists the options of each one:
`review`, `publish`, `setup`, `init`, `index`, `rules`, `prompt`, `watch`, `enqueue`, `mcp`,
`history`, `misses`, `lessons`, `fix` and `reply`.

To have new pull requests and pushes reviewed without running anything, see
[Watch mode](watch-and-requests.md#watch-mode); to see what happened to the comments Phada
published, see [History](history-and-lessons.md#history), and for what people pointed out that
Phada did not, [Misses](history-and-lessons.md#misses) and
[Lessons](history-and-lessons.md#lessons). To see all of it in one place, run `phada` alone (see
[Terminal app](terminal-app.md#terminal-app)).

## Requirements

- Node.js 22.13 or newer.
- `git`, for the [repository investigation](review-context.md#repository-investigation) and
  `phada index`. Without it, the AI only sees the diff and the context.
- A GitHub token that can read the pull request and write reviews, or the login of the GitHub CLI
  (`gh`) (see [GitHub token](#github-token)).
- One AI provider: Claude Code, Codex CLI or Ollama (see
  [Requirements of each provider](providers.md#requirements-of-each-provider)).

## GitHub token

Phada reads the token from `GITHUB_TOKEN`, or from `GH_TOKEN` when `GITHUB_TOKEN` is not set.
Without either, it uses the login of the GitHub CLI: after `gh auth login`, every command works
with no variable to export. Phada asks `gh auth token` (or, on older `gh` versions without it,
`gh auth status --show-token`) once per run, only when a command needs GitHub, and never saves or
prints the token.

The token reads the pull request and its reviews and publishes a review, so it needs:

- a fine-grained token with **Contents: Read-only** and **Pull requests: Read and write** on the
  repository, plus **Checks: Read-only**, **Commit statuses: Read-only** and **Actions:
  Read-only** for the [CI checks](review-context.md#the-checks), or
- a classic token with the `repo` scope (`public_repo` is enough for public repositories).

What each part of that access is for:

- A read-only token is enough with `--dry-run`.
- `phada reply` answers in review threads, which needs **Pull requests: Read and write**.
- `phada fix` on a pull request pushes a commit to its branch, so it needs **Contents: Read and
  write**.
- Without write access, Phada still prints the review and then stops with an error that names the
  missing permission.
- **Contents: Read-only** lets Phada read the repository's rules and docs (see
  [Rules and repository context](review-context.md#rules-and-repository-context)); without it,
  the review runs on the diff alone and says so.
- Without one of the CI permissions, the review runs without that part of the checks and warns
  with the permission the token lacks, e.g.
  `CI check runs were not read: GitHub denied reading the check runs (HTTP 403): the token needs the checks:read permission.`

## Reviewing a pull request: `phada review`

`phada review owner/repo#123` (or the URL of the pull request) reviews the pull request with the
AI provider of your config, or `claude` by default, and publishes one review on it as the owner of
the token: a comment on the line of each finding and the rest in the review body. What the review
holds is in [What a review looks like](publishing.md#what-a-review-looks-like), and what gets
posted, skipped or resolved in [Publishing](publishing.md#publishing). Its options are in
[Options](#options).

### Your branch, before the pull request

`phada review` with no pull request, inside a clone of a GitHub repository, reviews the commits of
the branch you are on against where it left the default branch: the merge base of `HEAD` with
`origin/<default branch>`, as your clone last fetched it. Phada never fetches your remotes; run
`git fetch origin` when it is behind. The GitHub repository is the one of `origin`. Nothing is
posted anywhere.

```bash
phada review                    # the commits of this branch
phada review --uncommitted      # plus what is staged, modified or untracked (not ignored)
phada review --base release/2.x # against another branch, tag or commit
phada review --format json      # for scripts and AI agents
```

It is the review of the pull request you are about to open: the same rules and docs (read from
your clone at the merge base), the same repository graph, the same related repositories and the
same AI. The title is the subject of the only commit, or the branch name when there are several,
and the description is every commit message, so the claims of your commit messages are checked
too.

With `--uncommitted`, Phada writes a commit of your working tree with a temporary index (your
index, refs and `git status` do not change) and reviews it, so the graph and the AI's tools see
your uncommitted files. When there is nothing uncommitted, it says so and reviews the commits.

There is no conversation, CI, recheck or publication, a skill that runs natively runs as text,
and the review does not count in the feedback, misses or lessons of the repository. It needs the
GitHub token like any review, to read the default branch, whether the repository is private, and
the related repositories.

The review is saved in the [history](history-and-lessons.md#history) as a local run, named
`owner/repo@branch (local)` (`*` after the branch when it included uncommitted changes).
`phada publish` refuses it, since it has no pull request. `--dry-run` is accepted and changes
nothing; `--force`, `--wait-ci`, `--head`, `--no-resolve`, `--no-conversation` and `--no-ci` need
a pull request. In `--format json`, a `local` block (`repo`, `branch`, `base`, `head`, `dirty`,
`reviewed`, `title`) takes the place of `pullRequest`, `publication`, `conversation` and `ci`.

## Fixing the findings: `phada fix`

```bash
phada fix                        # the findings of the last local review of this branch
phada fix owner/repo#123         # the open comments of Phada on a pull request: commit and push
phada fix owner/repo#123 --list  # print them numbered, and stop
phada fix --only 1,3             # only these
phada fix owner/repo#123 --yes   # commit and push without asking
```

`phada fix` starts with the findings, numbered: with no pull request, those of the last local
review of the branch you are on, numbered as the review printed them; with a pull request, the
open comments Phada published on it, numbered by file and line. `--list` prints them and stops,
and `--only` fixes only the numbers you pick.

Phada applies the [suggested changes](publishing.md#suggested-changes) itself, with no AI:

- in your branch, where the lines still hold the code the review saw (or where that code appears
  once in the file);
- on a pull request, at the current lines of each comment that is not outdated, as GitHub's
  "Apply suggestion" does.

The findings left go to your AI CLI, with the findings as data. Claude Code edits the files with
its file tools and runs only git commands that read, and Codex edits in its `workspace-write`
sandbox. Each says, per finding, whether it fixed it or skipped it and why. With Ollama,
`phada fix` applies only the suggestions and lists the findings left. The provider and model come
from your config, or from `--provider` and `--model` as in `phada review`.

### Fixing your branch

With no pull request, the fix stays in the working tree of your clone, uncommitted, and needs no
GitHub token. It ends with the suggestions applied, the files the fix changed (changes already in
the working tree do not count), what the AI fixed and the findings left. When `HEAD` moved since
the review, it warns and goes on.

### Fixing a pull request

With a pull request, nothing happens in your clone: Phada fixes a checkout of the head of the pull
request made from its mirror, shows the diff and what was left, and asks
`Commit and push to owner/repo:branch? [y/N]`. Saying no, or nothing changing, removes the
checkout. Yes (or `--yes`, required when stdin is not a terminal) makes one commit,
`fix: address review comments`, with a `- file:line title` line for each applied suggestion and
each finding the AI says it fixed, and pushes it to the branch of the pull request:

- The commit is yours: the `user.name` and `user.email` of `git config` where you run
  `phada fix` (your clone's, inside a clone; otherwise your global config). Without them, it stops
  before anything runs. It is signed when your config signs commits (`commit.gpgsign`,
  `user.signingkey`, `gpg.*`), and no git hook runs.
- The push is a plain one, never forced, with the token in the environment of git only. Phada
  checks the head of the pull request when it reads the comments and again before the commit:
  when the branch moved since the fix read it, or the push is rejected because it moved, nothing
  is pushed; run `phada fix` again.
- After the push, it prints the commit and the branch, and when your clone is on that branch, it
  tells you to `git pull`. The fix does not resolve the comments: the next review rechecks them
  and resolves the fixed ones (see
  [Comments fixed in a new commit](publishing.md#comments-fixed-in-a-new-commit)).

A pull request from a fork, a closed one, or a token that cannot push to the repository is refused
before anything runs: the token needs **Contents: Read and write** (or the `repo` scope) to push.

### Options of `phada fix`

| Option              | What it does                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `--provider <name>` | AI provider: `claude`, `codex` or `ollama` (default: the one of your config, or `claude`) |
| `--model <name>`    | Model (default: the one of your config, or the provider's)                                |
| `--only <numbers>`  | Fix only these findings, e.g. `--only 1,3`                                                |
| `--list`            | Print the findings and stop                                                               |
| `-y`, `--yes`       | With a pull request: commit and push without asking                                       |
| `--debug`           | Show error details                                                                        |

## Answering replies: `phada reply`

When people answer Phada's comments, `phada reply` answers them back with the AI:

```bash
phada reply owner/repo#123 --dry-run    # what it would answer, posting and keeping nothing
phada reply owner/repo#123
```

It reads the open threads of Phada's comments on an open pull request (a closed or merged one is
refused) and takes the replies written after Phada's last comment in each thread, by the author of
the pull request or an owner, member or collaborator of the repository, never by a bot. A thread
gets at most 3 answers from Phada.

For each thread, one AI call gets Phada's comment, the whole thread (the replies of people as
data, never as instructions), the code around the comment, the title and description of the pull
request and, when the repository mirror can be read, Phada's read-only tools on the head of the
pull request. The AI classifies the reply:

| Kind        | Meaning                                              | What Phada does                                  |
| ----------- | ---------------------------------------------------- | ------------------------------------------------ |
| `ack`       | Thanks or acknowledges; nothing to answer            | Nothing is posted                                |
| `applied`   | Says it is fixed or will be                          | Nothing is posted                                |
| `question`  | Asks something about the comment                     | Posts the answer, citing the code                |
| `disagreed` | Disagrees, but does not show the comment is wrong    | Posts Phada's position, with evidence from code  |
| `refuted`   | Shows the comment is wrong, and the code confirms it | Posts an acknowledgement and resolves the thread |

The answers are posted as the owner of the token, in the `language` of your config (or the
language of the reply without one), and end with a visible line, "🦋 Automatic reply from Phada",
so nobody takes them for something you wrote. Each reply it classifies is kept in the
[history](history-and-lessons.md#history) and never classified again; with `history: false`, only
the replies after Phada's last comment count. A thread resolved while it runs is skipped. It uses
the provider of your config, like `phada review`.

It prints, for each thread, the file and line, the kind, what happened (`posted`,
`posted and resolved`, `no answer needed`, `skipped (thread resolved)` or `not posted (dry run)`)
and the answer, then a summary; with nothing to answer, it says so. `--format json` prints:

```json
{
  "pullRequest": { "repo": "owner/repo", "number": 123 },
  "dryRun": false,
  "limited": false,
  "threads": [
    {
      "threadId": "PRRT_…",
      "url": "https://github.com/owner/repo/pull/123#discussion_r1",
      "file": "src/shop.ts",
      "line": 63,
      "kind": "question",
      "text": "The check runs in spend(), line 40.",
      "posted": true,
      "resolved": false,
      "answerUrl": "https://github.com/owner/repo/pull/123#discussion_r2",
      "skipped": null
    }
  ]
}
```

`text` is `null` for `ack` and `applied`, `line` is `null` for a thread on a line that is gone,
and `skipped` is `"resolved"` for a thread resolved while it ran. When the AI usage limit stops
it, `limited` is `true` and the threads not answered are answered on the next run.

The token needs **Pull requests: Read and write**; without it, Phada stops with an error that says
so. `phada watch` answers replies on its own (see
[Watch mode](watch-and-requests.md#watch-mode)). A pull request whose diff is too large to review
still gets its replies answered: they never read the diff.

Its options are `--dry-run` (show the kind and the answer of each thread; post and keep nothing),
`--format text|json` (default `text`) and `--debug`.

## Other commands

Each of these commands has its own page; `phada <command> --help` lists its options.

### `phada publish`

`phada publish <id>` publishes a dry run kept in the history, exactly as it was found, without
running the AI again. Options: `--force`, `--format text|json`, `--debug`. See
[Look first, publish later](publishing.md#look-first-publish-later).

### `phada setup`

`phada setup` opens the app on the step-by-step setup: the GitHub token, the AI provider, the
language, the repositories to watch, their graph and the `.phada/` folder of this repository.
Every step can be skipped, and nothing is written before you confirm it. In a terminal, `phada`
opens it by itself while you have no config of your own. See
[Setup](terminal-app.md#setup).

### `phada init`

`phada init` creates commented `.phada/` files in this repository; `phada init --global` creates
your own config, and `phada init --global owner/repo` the one for a single repository. See
[Configuration](configuration.md#configuration).

### `phada index`

`phada index owner/repo [--ref <ref>]` builds a map of the repository's code on this machine. See
[Repository map](configuration.md#repository-map).

### `phada rules`

`phada rules owner/repo[#N]` shows the rules and docs a review would read, without calling the AI.
See [See the context without a review](review-context.md#see-the-context-without-a-review).

### `phada prompt`

`phada prompt owner/repo#N` (or `--default`) shows the prompt a review would send, without calling
the AI. See [See the prompt](review-context.md#see-the-prompt).

### `phada watch`

`phada watch` reviews new pull requests and pushes of the repositories in your config on its own.
See [Watch mode](watch-and-requests.md#watch-mode).

### `phada enqueue`

`phada enqueue owner/repo#N` asks the watch to review a pull request now. See
[From a script: `phada enqueue`](watch-and-requests.md#from-a-script-phada-enqueue).

### `phada mcp`

`phada mcp` is an MCP server over stdio that lets your AI ask for reviews. See
[From your AI: `phada mcp`](watch-and-requests.md#from-your-ai-phada-mcp).

### `phada history`

`phada history` shows past reviews and what happened to Phada's comments. See
[History](history-and-lessons.md#history).

### `phada misses`

`phada misses` shows what people pointed out on reviewed pull requests and Phada did not. See
[Misses](history-and-lessons.md#misses).

### `phada lessons`

`phada lessons` shows the lessons Phada proposes from the misses. See
[Lessons](history-and-lessons.md#lessons).

## Options

The options of `phada review`. They can also come from `.phada/config.yml` in the repository and
from your own config (see [Configuration](configuration.md#configuration)); flags win.

| Option                 | What it does                                                                                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--provider <name>`    | AI provider: `claude` (default, unless your config sets one), `codex` or `ollama`                                                                                                                                                                                                                                          |
| `--model <name>`       | Model to use. Required for Ollama. Default: for Claude, the Claude Code default model (`ANTHROPIC_MODEL`, or the `model` in `~/.claude/settings.json`, or in `$CLAUDE_CONFIG_DIR/settings.json`), else `opus`; for Codex, the `model` in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), else the Codex CLI default |
| `--language <tag>`     | Language of the review, e.g. `pt-BR`. The AI writes its text in it, and Phada's own headings and labels follow it in English (`en`), Portuguese (`pt`, `pt-BR`) and Spanish (`es`, `es-MX`, …); other languages keep those labels in English. Default: English                                                             |
| `--min-confidence <n>` | Confidence cut, a whole number from 50 to 100. Findings at the cut or above are shown and scored; the ones from 50 up to the cut are listed as worth checking. Default: 60                                                                                                                                                 |
| `--format <name>`      | Output: `markdown` (default) or `json`. See [JSON output](#json-output)                                                                                                                                                                                                                                                    |
| `--no-investigate`     | Reviews without letting the AI read the rest of the repository (see [Repository investigation](review-context.md#repository-investigation)); `--investigate` turns it back on when the config turns it off                                                                                                                 |
| `--verify`             | Checks every finding with a second call to the AI before scoring (see [Verification](publishing.md#verification)). On by default; `--no-verify` (or `verify: false`) turns it off, `--verify` turns it back on when the config turns it off                                                                                |
| `--no-continuation`    | Skips the continuation pass of a review with low coverage (see [What a review looks like](publishing.md#what-a-review-looks-like)); same as `review.continuation: false`; `--continuation` runs it when the config turns it off                                                                                            |
| `--groups`             | Reviews a [large pull request](publishing.md#large-pull-requests) in diff groups; same as `review.groups: true`; `--no-groups` reviews it in one piece when the config turns grouping on                                                                                                                                   |
| `--no-resolve`         | Neither rechecks Phada's comments from earlier commits nor resolves the fixed ones (see [Comments fixed in a new commit](publishing.md#comments-fixed-in-a-new-commit)); same as `resolveThreads: false`                                                                                                                   |
| `--no-conversation`    | Does not send the comments, reviews and threads of the pull request to the AI (see [The conversation](review-context.md#the-conversation)); same as `conversation: false`                                                                                                                                                  |
| `--no-ci`              | Does not read the checks of the head: no CI for the AI and no CI line in the review (see [The checks](review-context.md#the-checks)); same as `ci.read: false`                                                                                                                                                             |
| `--wait-ci`            | Before reviewing, waits for the pending checks of the head for at most `ci.wait` (default 15 minutes) since the command started (see [Waiting for the checks](review-context.md#waiting-for-the-checks))                                                                                                                   |
| `--skill <name>`       | Reviews with this skill, one pass each when repeated (`plugin:skill` for a skill of a plugin; `phada` is the built-in reviewer); replaces `review.skills` (see [Review focus and skills](review-context.md#review-focus-and-skills))                                                                                       |
| `--head <sha>`         | Replays the review at an earlier commit of the pull request; only with `--dry-run` (see [Replaying an earlier commit](publishing.md#replaying-an-earlier-commit))                                                                                                                                                          |
| `--base <ref>`         | With no pull request: reviews the branch against this branch, tag or commit of your clone instead of `origin/<default branch>` (see [Your branch, before the pull request](#your-branch-before-the-pull-request))                                                                                                          |
| `--uncommitted`        | With no pull request: also reviews what is staged, modified or untracked (not ignored)                                                                                                                                                                                                                                     |
| `--dry-run`            | Prints exactly what would be published (the review body and every comment) and posts nothing                                                                                                                                                                                                                               |
| `--force`              | Reviews and publishes even when Phada already reviewed this commit (see [Publishing](publishing.md#publishing))                                                                                                                                                                                                            |
| `--debug`              | Shows error details                                                                                                                                                                                                                                                                                                        |

`phada review` also reads these environment variables: `GITHUB_TOKEN` and `GH_TOKEN` (see
[GitHub token](#github-token)), `OLLAMA_HOST` (see
[Local models with Ollama](providers.md#local-models-with-ollama)) and `PHADA_CONFIG_HOME` (see
[Configuration](configuration.md#configuration)).

### JSON output

The JSON of `--format json` (`schemaVersion: 1`) carries the same review as data:

- the [verdict](watch-and-requests.md#review-events-and-hooks), score, coverage, summary, every
  changed file, the findings (each with its `scope`), the repository `debt`, the findings worth
  checking, the dropped counts, the verification (unless `--no-verify`), provider, model, time and
  tokens;
- a `publication` block: `published` with the URL and the `body` and `lineComments` it posted,
  `failed` with the error and what it tried to post, `dry-run` with the exact body and comments,
  or `skipped`; with the number of findings `stillOpen` and `dismissed`;
- a `context` block (see
  [Rules and repository context](review-context.md#rules-and-repository-context));
- `conversation` and `ci` blocks (see [Conversation and CI](review-context.md#conversation-and-ci));
- an `investigation` block (see
  [Repository investigation](review-context.md#repository-investigation));
- an `impact` block (see [Repository graph](review-context.md#repository-graph)).

## Exit codes

| Code | Meaning                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | The review was published (or printed with `--dry-run`), Phada skipped a commit it already reviewed, or the pull request has no changes to review (or only ignored files) |
| 1    | Something failed: GitHub, the AI provider, an answer that is not a review, or publishing (the review is printed first)                                                   |
| 2    | The command line or your own config is wrong (unknown option, invalid pull request reference, invalid `config.yml`, a skill that is not installed, …)                    |

The other commands:

- `phada review` with no pull request exits with 0 when it printed the review, 1 when there is
  nothing to review against the base or GitHub, git or the AI failed, and 2 outside a git
  repository or with an unknown `--base`.
- `phada fix` exits with 0 when it finished (including when there is nothing to fix or you answer
  no), 1 when it refused the target (no local review of the branch, a fork, a closed pull request,
  a token that cannot push, no `user.name` or `user.email`, a branch that moved, a failed push) or
  GitHub, git or the AI failed, and 2 when the command line or your config is wrong, an `--only`
  number does not exist, or stdin is not a terminal without `--yes`.
- `phada index` exits with 0 when the map was built and 1 when fetching or writing it failed.
- `phada rules` exits with 0 when it printed the context and 1 when GitHub could not be read.
- `phada prompt` exits with 0 when it printed the prompt, 1 when GitHub could not be read and 2
  when a skill or the `review.prompt` file is missing.
- `phada history` exits with 0 when it printed the history and 1 when the file or, with
  `--refresh`, GitHub could not be read; `phada history show` exits with 1 when the history has no
  run with that id.
- `phada publish` exits with 0 when it published the run or skipped a commit Phada already
  reviewed, 1 when it refused the run (unknown, not a dry run, the pull request moved) or GitHub
  failed, and 2 when the command line is wrong.
- `phada enqueue` exits with 0 when the request was queued or joined a job, 1 when it was refused
  or GitHub could not be read, and 2 when the command line or your config is wrong.
- `phada reply` exits with 0 when it answered the threads (or had nothing to answer), 1 when the AI
  usage limit stopped it, GitHub refused the answer or the AI failed, and 2 when the command line
  is wrong or the pull request is closed.
- `phada mcp` exits with 0 when its input ends.
- `phada` with no command and `phada setup` exit with 0 when you quit the app, 130 on Ctrl-C, 143
  on `SIGTERM`, 1 when it failed and 2 outside a terminal.
- `phada watch` exits with 0 when it stopped or `--once` finished, 1 when it stopped on an error
  (another watch running, an AI CLI that is not logged in, a token GitHub rejects), 2 when the
  command line or your config is wrong, and 130 when a second Ctrl-C aborted it.
