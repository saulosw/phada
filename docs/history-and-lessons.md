# History, misses and lessons

What Phada keeps on your machine about the reviews it ran, and what it learns from them: the
history of every run, what happened to each comment it published, the problems people pointed out
that Phada did not (misses), whether Phada catches them now, and the lessons it proposes from the
team's comments. All of it stays in a local file; nothing here is ever published. The Learnings
screen of the [terminal app](terminal-app.md#terminal-app) shows the same.

## History

Every review is saved on your machine in `~/.local/share/phada/history.sqlite`
(`$XDG_DATA_HOME/phada` when set; `PHADA_DATA_HOME` to choose another folder): the reviews of the
watch, its queue and failures, and every `phada review`, including `--dry-run` and skipped runs.
Each run keeps the same JSON as `--format json`, without the diff; findings can still quote code,
so the file stays readable only by you. Unlike the [cache](configuration.md#cache), the history is
never rebuilt or deleted by Phada; a newer version updates it in place, and an older one refuses a
file written by a newer one instead of touching it. `history: false` in your own config turns it
off (`phada watch` needs it).

```bash
phada history                         # the last 50 reviews
phada history owner/repo --since 30d  # one repository, the last 30 days
phada history owner/repo#123          # one pull request, with what happened to each comment
phada history show 42                 # one run, with everything it sent and found
phada history --stats                 # what happened to the comments, per repository
phada history --refresh --stats       # read the comments on GitHub first
phada history prune --older-than 180d
```

`--since <age>` takes ages such as `30d` or `12h`, and `--limit <n>` shows at most `n` reviews
(50 by default).

Each review of the watch shows who asked for it: `watch` (the polling), `enqueue`, `mcp`,
`pr-command` or `slack`. A [review of your branch](commands.md#your-branch-before-the-pull-request)
shows as `owner/repo@branch (local)` in `phada history owner/repo` and in the app.

Each run of the list starts with its id, and `phada review` ends with it when it saves the run
(`Saved as run 42: phada history show 42`). `phada history show <id>` prints that run again with
the sections of `--dry-run`, read from the history: what was posted on the pull request (or would
have been), the findings close to the cut, the claims of the description, the context,
conversation and CI sent to the AI, the impact, the related repositories, the skills, what the
investigation read and the tokens. It starts with a line naming the run, the pull request, its
commit, when, who asked, the provider and model, and how it ended (published with the link, dry
run, skipped and why, failed and the error). A run saved by an older version shows the sections it
kept. `--format json` prints the run's history fields under `run` and its saved JSON under
`result`, with `schemaVersion: 1`.

### What happened to each comment

The history also keeps every comment Phada published and what happened to it, read from the
comment's thread on GitHub, without the AI. Each comment has one outcome:

- **fixed**: Phada resolved it after a recheck (see
  [Comments fixed in a new commit](publishing.md#comments-fixed-in-a-new-commit)), or a person
  resolved it after the lines it points at changed;
- **dismissed**: a person resolved it without the lines changing;
- **ignored**: it was still open when the pull request was merged or closed;
- **open**: none of the above yet.

And two marks: **negative reaction** (a 👎 or 😕 on the comment) and **replied** (someone answered
in the thread; Phada's own replies and bots do not count). Outcomes and marks follow the thread: a
resolved comment that is reopened is open again, and a removed reaction stops counting. The
history keeps when each one started and, when it stopped, when.

When Phada classifies the replies in a thread (with
[`phada reply`](commands.md#answering-replies-phada-reply) or the watch), each comment also shows
the kinds of reply it got: `ack`, `applied`, `question`, `disagreed` or `refuted`, with how many
of each (`replies: question 2, refuted 1`). They are a signal next to the outcome, not an outcome.

`phada review` saves the state of the threads it reads on every run. `phada watch` also reads the
pull requests Phada reviewed (with comments or not, dry runs included) every 30 minutes when the
queue is idle (at most 10 pull requests a cycle), and once more when they are merged or closed.
Without the watch, `phada history --refresh` reads them on demand (it needs a GitHub token);
`phada history owner/repo#123 --refresh` reads that pull request even when the history has nothing
about it yet.

`--stats` counts the comments published in the period per repository, with the share of each
outcome, the marks and how many comments got each kind of reply (only the kinds some comment got).
They are signals, not verdicts: a dismissed comment may still have been right.

`--format json` prints the runs, the comments with their outcome, the history of each signal and
the count of each reply kind (`replies`), or the stats (each repository with `replies`, the
comments that got each kind), with `schemaVersion: 1`.

`phada history prune --older-than <age>` removes reviews, comments and finished jobs older than
that age (`1d` at least); it never touches what the watch needs to know what it already saw.

## Misses

A miss is a problem someone pointed out that Phada did not. It comes from one of three places (its
**origin**):

- **person**: a thread opened on a pull request by someone who is not a bot, not Phada and not the
  author of the pull request, on lines that a later commit changed (GitHub marks the thread
  outdated), with no Phada finding near it;
- **bot**: the same, from a bot you list in `misses.bots` (see below); other bots never count;
- **phada**: a finding of Phada (from any review of the pull request, a replay included) that the
  latest review at a later commit no longer reports, although the lines it points to did not change
  between the two commits. A finding Phada published as a comment is left out, and so is one whose
  comparison GitHub cannot give (after a force-push, say).

Each miss is also marked **missed-live** when Phada had reviewed the pull request before the
thread (or, for `phada`, the review that lost it), or **not-reviewed** when Phada never had: a pull
request Phada never reviewed still gives misses, so the list grows from the first day.

A finding is **near** a thread when it is in the same code element: the innermost function,
method, class, type or top-level declaration that holds the line, read from the file at that
commit (TypeScript, JavaScript, Python and Go). For other files, for a line outside any element, or
when the file cannot be read, near means within 5 lines; in an element longer than 80 lines,
within 10. General comments, without a file and a line, are not misses.

Each miss keeps the commit Phada reviewed, the commit to replay, the file and lines, the author and
their role in the repository (owner, member, collaborator, contributor or external), the comment
(up to 2 KB) and the link to the thread.

To count the threads of a review bot as misses, list its login in your own config (globally, or in
`repos/<owner>/<repo>/config.yml`; a repository's `.phada/` cannot set it):

```yaml
misses:
  bots: [review-bot]
```

Misses are collected without the AI whenever the comments are read (by the watch, by
`phada history --refresh` and by `phada misses --refresh`) and stay only in the history on your
machine: Phada never publishes them.

```bash
phada misses                          # the open misses
phada misses owner/repo --all         # one repository, dismissed ones included
phada misses --refresh                # read the reviewed pull requests on GitHub first
phada misses owner/repo#123 --refresh # read that pull request, even one the history lacks
phada misses owner/repo --refresh --since 2026-10-01
                                      # also the pull requests closed or merged since that day
phada misses dismiss 7                # take miss 7 off the list
```

`--since <YYYY-MM-DD>` (from 00:00 UTC that day) reads the pull requests of the repository closed
or merged since that day (the 50 closed last), besides the ones the history follows, without the
AI.

Each miss starts with its id, its origin and its mark; a dismissed miss stays dismissed when it is
collected again. `--format json` prints them with `schemaVersion: 1`.

### Replaying the misses

`phada misses --replay` checks whether Phada catches its misses now. It groups the open misses by
pull request and by the commit the person commented on, and reviews each group once with your AI,
as the pull request was at that commit (a dry run, as `phada review --head` does): each group is a
full review, and a line before each one says which pull request, commit and how many misses it
covers. A miss is **caught** when the replay finds something near it (as above, in the file at that
commit), **missed** otherwise.

The replays are kept in the history as runs of their own (never published, never counted as
feedback), and the outcome of each miss is kept per Phada version: replaying again with the same
version replaces it. The output lists each miss with its outcome and the total
(`3 of 7 caught in 0.12.0.`), and, when an earlier version replayed the same misses, its tally over
them.

A pull request whose review fails, or runs no AI (an empty diff, every changed file ignored, no
skill that applies), is a warning, its misses get no outcome, and the replay goes on with the next
one. Ctrl-C stops after the current review (twice aborts it).

```bash
phada misses --replay                 # every open miss
phada misses --replay owner/repo      # the open misses of one repository
phada misses --replay --format json   # outcomes and tallies as data (schemaVersion: 1)
```

## Lessons

The misses of people of the team (the owner, a member or a collaborator of the repository) can
teach the review a rule.

`phada lessons --refresh` first reads, on GitHub, the pull requests closed or merged in each
repository (the one you name, or every repository with a review in the history) and keeps the
comments of the team as misses, the same way `phada misses --refresh` does, also on pull requests
Phada never reviewed. The first time it reads the last 90 days; then only what closed after the
newest pull request it read (a cursor per repository, kept in the history and moved only when every
pull request of the run was read); `--since YYYY-MM-DD` reads from that day instead. It reads at
most the 200 most recently closed pull requests of a repository per run, and needs a GitHub token
(`GITHUB_TOKEN`, `GH_TOKEN` or your `gh` login).

Then it sends to your AI the open misses of team people that no lesson holds and that it never sent
before, 50 at a time (the most recent first, at most 5 calls per repository per run; the rest waits
for the next run), with up to 25 earlier misses no lesson holds yet as context, the pending lessons
and the rules of your own config for that repository; with no new miss it makes no call. The AI
proposes a lesson only when the comments show a rule that repeats there (a convention or a
recurring risk, not a one-off bug) as one rule, the files it covers (globs from the files of its
comments) and the misses it comes from; a miss can also join a pending lesson. Comments of bots, of
people outside the team, of the pull request's author and of Phada never become lessons as misses,
and the comments reach the AI as data, never as instructions. It uses the provider and model of
your config.

### Lessons from refused comments

The same call also gets the comments Phada published that the team refused: resolved as dismissed
or refuted, answered with a 👎, or replied to with a reply Phada classified as `refuted` or
`disagreed`. Each goes with its text, severity and rule, the signals of the team and the replies in
its thread (their text kept from now on, cut to 2 KB), 30 never sent at a time with up to 15
earlier ones no lesson holds yet as context, and with up to 20 comments Phada published in the same
files that the team fixed.

From them the AI can propose an **avoid** lesson: one or two sentences on what the review should
not report in those files, only when the comments show something it keeps reporting that the team
does not want there (a convention or an accepted trade-off, not a one-off wrong comment), and never
one that would hide a fixed comment, a security hole, data loss or a crash.

### Accepting a lesson

A lesson never reaches a review on its own. `phada lessons` lists the pending ones in full, with
their files, how many misses back them and the link of each thread. `accept` adds one as the rule
`lesson-<id>` (its rule, its files as `scope` and the links of its threads as `from`) to `rules:`
of your own config for that repository, `repos/<owner>/<repo>/config.yml`, keeping the comments and
the order of the file. From then on the review applies it like any other rule
([`phada rules`](review-context.md#see-the-context-without-a-review) shows it, and a finding can
name it):

```yaml
# ~/.config/phada/repos/acme/shop/config.yml
rules:
  - id: lesson-7
    rule: Validate request bodies at the edge of the API, before any call to the database.
    scope:
      - src/api/**
    from:
      - https://github.com/acme/shop/pull/12#discussion_r123
```

An avoid lesson is marked `avoid` and lists the comments of Phada it comes from (title, file and
line, and the link of each thread) instead of misses; the ones more misses or comments back come
first. Accepting it writes a rule with `kind: avoid` (and no `severity`) whose `from` holds the
threads of those comments; from then on the reviews of that repository stop reporting what it
describes in its files (see the exceptions in
[Rules and repository context](review-context.md#rules-and-repository-context)):

```yaml
rules:
  - id: lesson-8
    kind: avoid
    rule: Do not ask for comments on the config loaders; the team documents them in docs/.
    scope:
      - src/config/**
    from:
      - https://github.com/acme/shop/pull/15#discussion_r456
```

That file is the rule's only copy: edit or remove it there. `discard` drops a lesson and writes
nothing.

`accept --edit` first opens the rule and its files in `$VISUAL`, `$EDITOR` or `vi`, with the links
of its threads as comments; Phada sets `id` and `from`. Saving writes the rule as edited, after the
same checks as any rule; saving an empty file, or an editor that ends with an error, cancels and
leaves the lesson pending.

The Learnings screen of the [terminal app](terminal-app.md#terminal-app) shows the pending lessons
of each repository and accepts or discards them (`l`, then `a` or `d`), showing the file and the
rule before it writes; it never proposes them.

```bash
phada lessons --refresh               # read the closed pull requests, then propose lessons
phada lessons --refresh owner/repo --since 2026-06-01   # one repository, from that day
phada lessons owner/repo --all        # one repository, accepted and discarded ones included
phada lessons accept 7                # add lesson 7 as the rule lesson-7
phada lessons accept 7 --edit         # edit it first
phada lessons discard 7               # drop lesson 7
phada lessons --format json           # as data (schemaVersion: 1), with kind and findings
```
