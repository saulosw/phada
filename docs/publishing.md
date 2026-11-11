# Reviews and publishing

What a Phada review holds (the score, the coverage, the findings and how they are checked) and
what Phada posts on the pull request: when it reviews or skips a commit, how it treats its earlier
comments, how to look at a review before publishing it, and how to replay an earlier commit.
Answering the replies to Phada's comments is in
[Answering replies: `phada reply`](commands.md#answering-replies-phada-reply).

## What a review looks like

Phada sends the diff with the line number of every added and context line, so the AI copies the
line instead of counting it. The AI answers in a fixed JSON shape that Phada validates, and every
finding must point to a file of the pull request and a line inside the diff. Phada then prints:

- **Confidence score (0–5)**, computed by Phada from the findings, never by the AI: 5 means no
  problems found, 4 only P2 findings, 3 one P1, 2 two or more P1, 1 one P0, 0 two or more P0.
  Neither the AI nor text inside the pull request can set the score directly; it only follows the
  findings.
- **Coverage** next to the score when the review did not look at every file (see
  [Coverage](#coverage)), e.g.
  `5/5 (ready to merge) · low coverage: 11 of 63 files (52 files not accounted for)`.
- **Summary** of what the pull request changes and a **table of the changed files**.
- **Findings grouped by severity**, each with file, line, confidence (0–100), why it matters and a
  suggested fix (with the exact code change when the fix is a local edit, see
  [Suggested changes](#suggested-changes)). Only findings at the confidence cut or above are shown
  here (60 by default, see `--min-confidence`):
  - **P0 · Must fix**: security holes, data loss, crashes, wrong money handling;
  - **P1 · Should fix**: bugs, incorrect behavior, edge cases, race conditions, leaks;
  - **P2 · Consider**: maintainability or design risks with a concrete consequence.
- **Worth checking**: up to five findings with confidence from 50 up to the cut, one line each.
  They do not change the score.
- **Rejected by verification**: each candidate the [verification](#verification) turned down,
  with its place, confidence and the reason; only in the terminal, never on the pull request.
- **Repository debt**: problems that are real but that this change neither introduces nor worsens
  (an exported function no caller uses that the change only touches, say), one line each with its
  place and why. See [Repository debt](#repository-debt).
- A footer with how many findings there are, how many are worth checking, how many were dropped
  (rejected by verification, outside the diff, duplicates, below confidence 50, not in the
  expected shape, repository debt with `review.debt: off`, or
  [reimplementations](#reimplementations) without the existing code read) and the provider, model,
  time and tokens.

### Findings

A finding sits at the changed line where the fix goes, such as the function that copies existing
code or the request without a `catch`, not at a line that only calls it or shows its effect.

Confidence is how sure the AI is that the problem is real and happens as described; how often it
happens and how much it costs go into the severity, so a real but rare bug is a sure finding with
a lower severity (a P0 stays P0 however rarely it happens).

A finding at most 10 points above the cut is marked **close to the cut**: the AI does not rate a
finding the same way every time, so another run of the same commit may leave it out. The mark and
their count show in the terminal review, in a "Close to the cut" section of `--dry-run`, in
`closeToCut` of each finding in `--format json` and the history, and in the review's detail in the
app; the comments posted on the pull request do not carry it.

### Coverage

The AI accounts for every changed file (judged from the diff, read whole, compared with existing
code, or skipped with a reason), and Phada checks that account against what the tools actually
read:

- a file said to be read but never read counts only as seen in the diff;
- a new file of 50 or more added lines counts only when the AI compared it with existing code it
  read outside the diff, or with the file of the diff its code moved out of.

The coverage is full when every file is covered, low below 70% of the files, and partial in
between; full shows nothing. It never changes the score or the verdict: it says how far the
findings can be trusted. Without the tools, the account is taken as given and the label says
`(declared)`.

When the coverage is low, Phada runs **one continuation pass**: the same review with the list of
what was left out and the findings already made, whose findings join the first ones
(`review.continuation: false` or `--no-continuation` turns it off).

The coverage is in the terminal review, the body posted on the pull request, `--dry-run` (with
each file left out), `--format json` (`review.coverage`), the history and the review's detail in
the app.

### Tokens

At the end, `phada review` prints on stderr the tokens of each call to the AI and their total.
The calls are each review pass (one per skill), the continuation pass, the verification and the
recheck of earlier comments; a native skill counts its run and the conversion of its output
together. For each, it shows the input tokens, how many of them came from the provider's cache,
and the output tokens, e.g.
`Tokens: review 812.0k in (640.0k cached) · 9.0k out; verify 120.0k in · 2.0k out; total 932.0k in (640.0k cached) · 11.0k out`.
A provider that does not report them shows `not reported` (Ollama reports no cache).

The same counts are in a "Tokens" section of `--dry-run`, in `usage` of `--format json` and the
history (`passes` with `pass`, `skill` and `usage`, and the `total`), in the review's detail in the
app and next to each AI step while the app runs a review.

### Verification

By default (turn it off with `--no-verify` or `verify: false`), the first pass asks the AI for
every candidate from confidence 25 instead of 50, and Phada makes a second call to the same AI
before scoring. It sends the pull request, the diff and the candidates, without their severity
and confidence, and asks a skeptical reviewer to confirm each one, with its own severity and
confidence, or reject it.

A finding is confirmed only when it can happen in the repository under review: when the effect it
claims depends on a condition (a setting, the callers, the log level, a flag, the inputs that
reach the code), the verifier looks for that condition with the
[investigation tools](review-context.md#repository-investigation) (without them, in the diff) and
rejects the finding, naming what is missing, when the repository does not meet it. How a library
behaves on its own is not enough.

Rejected findings leave the review and are counted in the footer; `--format json` lists them with
the reason, and gives the verifier's reason for every confirmed finding too (`null` for a finding
it did not check). Confirmed findings still below 50 are dropped like any other. A finding without
an answer keeps its first rating, and the footer says how many were left unchecked
(`not verified` when none got an answer). Verification adds about half the time and doubles the
tokens; the time and tokens shown are the total of both calls.

If the AI's answer is not a valid review, Phada stops with an error instead of printing it;
`--debug` shows the start of the answer.

### Large pull requests

With `review.groups: true` or `--groups` (off by default), when the diff has 30 KB or more of
code, Phada splits it into **diff groups** of about 20 KB each, by directory: a directory too
large is split by its subfolders, a single file larger than that is a group of its own, and there
are at most 6 groups. Each review pass runs once per group: the AI sees the diff of its group, the
list of every changed file with the ones of the group marked, the same context and the same tools
to read the rest. Findings outside the lines of a group are left out.

The answers are joined into **one review**: the summary is made from the part of each group, the
claims are merged, the coverage counts every group, and the continuation pass and the verification
run once over the whole diff. A pull request below 30 KB of code, or whose code fits in one group,
is reviewed as before. Grouping spreads the attention over every part of a large pull request, at
about twice the tokens.

Data files (`.json`, `.lock`, `.csv`, `.tsv`, `.svg`, `.snap`, `.txt`, `.md`, `.map`) and
generated files (marked `linguist-generated` in the `.gitattributes` at the root of the base
branch, or starting with `@generated` or `Code generated … DO NOT EDIT`) do not count toward those
sizes and never make a group of their own: they are reviewed with the group of the nearest
directory.

Groups run as many at a time as the provider takes: one with Ollama, two with Claude Code and
Codex; `review.groups: { concurrency: 1 }` to `4` sets it. A group whose answer is not a valid
review becomes a warning and its files are left as coverage gaps; a provider failure, such as a
usage limit, fails the review.

`phada review` prints `Group 2/4: api/src/services (6 files, 21 KB)` as each one starts. The
groups, with their files, size, findings, time and tokens, are in a "Groups" section of
`--dry-run` and of `phada history <id>`, in `groups` of `--format json` and the history, in
`phada prompt` and in the review's detail in the app. The body posted on the pull request does not
change. Native skills are never grouped. `--no-groups` turns grouping off for one review when the
config turns it on.

### Claims of the description

The title and description of a pull request are the author's account of the change, so the review
checks them instead of repeating them. The AI lists each concrete, checkable thing they assert the
change does or guarantees ("X prevents Y", "covers Z", "is backward compatible", "only runs on
main") and checks it against the diff and, with the tools, the repository: `confirmed` or
`contradicted` with the file and line that show it, or `unverified` with what is missing.

A contradicted claim that matters is also reported as a finding at the line that breaks it, and
the summary never states an unverified or contradicted claim as fact. The description stays data
to check: an instruction in it is never followed.

The claims show in a "Claims of the description" section of `--dry-run`, in `claims` of the review
in `--format json` and the history, and in the review's detail in the app; they are not posted on
the pull request.

When several skills review the pull request, the same claim is kept once, with the strongest
verdict (contradicted, then confirmed): case, spacing and punctuation do not tell claims apart,
and a claim of three words or more that another one only extends (`… to the topics` and
`… to the topics of A and B`) is the same claim. Once a skill has listed the claims, the
`unverified` ones of the skills after it are left out. An AI answer without the list still gives
a review, with a warning that the claims were not checked. A
[skill that runs natively](review-context.md#skills-that-run-natively) has its claims taken from
what it wrote, and only the ones it confirms or contradicts: one that reviewed nothing adds no
claims.

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

### Reimplementations

The built-in reviewer also looks for code the pull request writes again although the repository
already has code that does the same (a helper, a function, a module): a P2 finding, or P1 when the
copy diverges from the existing code and causes a bug.

Such a finding gives the place of the existing code in `existing` (`path:line`, or
`owner/repo:path:line` in a [related repository](review-context.md#related-repositories)), and
Phada keeps it only when the AI read that file during the review, with `read_file` or in the
results of a `grep`, and the line is not one the diff adds; the place then comes first in the
finding's sources. Otherwise:

- a P2 finding is dropped and counted in the footer, e.g.
  `1 dropped (1 reimplementation finding without the existing code read)`, in the terminal and in
  the body posted on the pull request (in the review language; `unbacked` in `dropped` of the
  JSON, and the dropped findings themselves in `unbacked`);
- a P0 or P1 finding is a problem on its own, so it stays without `existing`.

Without the [investigation tools](review-context.md#repository-investigation) nothing can be read,
so these P2 findings are always dropped. The verifier reads the cited code and rejects the finding
when that code does not do the same thing. Findings of a
[skill that runs natively](review-context.md#skills-that-run-natively) have no `existing` and stay
ordinary findings. `--format json` and the history give `existing` on every finding (`null` when it
has none).

### Suggested changes

When the fix of a finding is a local edit, the AI also gives the lines it replaces and the code
that takes their place. Phada keeps that suggestion only when the lines:

- are added or context lines of one `@@` section of the diff, at most 20 of them;
- include the line of the finding;
- are quoted exactly as they are in the diff;

and the new code differs from them and holds no hidden control or bidirectional characters.
Otherwise, the finding keeps only its fix in words. The verifier sees the suggestion too and drops
it when the new code would not fix the problem or would break something else.

A kept suggestion shows as a `diff` block in the terminal and is published as a GitHub suggestion
that the author applies with one click (`suggestion` in the JSON, and a `suggestions` count of
valid, invalid and dropped ones). [`phada fix`](commands.md#fixing-the-findings-phada-fix) applies
them without the AI.

## Publishing

Each run posts one GitHub review (a comment review, never an approval or a request for changes) on
the commit it reviewed, as the owner of the token:

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
again either (a different finding near it still is): the run says how many findings were dismissed
earlier and left out (`dismissed` in the JSON).

### What the AI cannot post

Text written by the AI cannot mention anyone, link other issues or pull requests (`#12`,
`owner/repo#12`), add HTML or forge Phada's own markers, and a body longer than GitHub allows is
shortened with a visible "(truncated)".

Two runs on the same pull request at the same time can both publish. GitHub refuses a new review
while you have a pending review of your own open in its interface; submit or discard it first.

### Look first, publish later

Another run of the AI can find something else, so publishing after a `--dry-run` should post what
the dry run found, not review again. `phada publish <id>` posts the dry run kept in the
[history](history-and-lessons.md#history) as run `<id>` (the id is at the end of
`phada review --dry-run` and in `phada history`), without calling the AI:

```bash
phada review owner/repo#123 --dry-run   # … Saved as run 42: phada history show 42
phada publish 42                        # posts exactly that review
```

It reads the pull request first and refuses when it moved to another commit since the dry run
(`The pull request moved from a1b2c3d to 9f8e7d6 since run 42`): review it again, or use `--force`
to publish on the commit the dry run reviewed, where the line comments still point.

It plans the comments against the threads on the pull request now, as a review does: a finding
whose thread is still open is not posted again, one dismissed earlier is left out, and the
comments the dry run found fixed are resolved if they are still open. A commit Phada already
reviewed is skipped unless `--force`, so publishing the same dry run twice posts it once. The
review is written in the language of the dry run.

Only a dry run that reviewed something can be published: a run already published, skipped or
failed is refused, and so is a dry run saved by a version before `phada publish`, which did not
keep everything the review needs. The publication is saved as a new run of the history
(`phada history show` names the dry run it came from), and `--format json` prints its JSON, with
`publishedFrom`. In the app, `p` on the result of **Only look** does the same, after asking.

| Option            | What it does                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--force`         | Publish even if the pull request moved since the dry run (the comments go on the commit it reviewed) or Phada already reviewed that commit |
| `--format <name>` | Output: `text` (default) or `json`                                                                                                         |
| `--debug`         | Show error details                                                                                                                         |

### Comments fixed in a new commit

On a new commit, Phada first rechecks its own open comments from earlier commits, one AI call for
all of them. For each comment, it sends what changed in that file since the comment was posted
(GitHub's comparison of the two commits) and lets the AI read the file at the new head. A comment
whose file did not change stays open without asking the AI, and so does one Phada cannot check (no
comparison after a rebase, and no access to the repository with `--no-investigate`).

The AI answers `fixed`, `still-valid` or `unsure` for each one, and Phada only acts on `fixed`:
right before posting the new review, it resolves the thread and replies "Fixed in `abc1234`: …"
with the reason. A comment that is still valid or unsure stays open. Phada never reopens a thread,
never touches threads of other people, and leaves alone a thread a person reopened after Phada
resolved it. A failure on one thread does not stop the others (the run says "Resolved N of M
comments found fixed" and warns about each failure).

The new review does not post again a finding of a comment found fixed in the same run; if the
problem comes back in a later commit, it is posted again, while a finding whose thread a person
resolved is never posted again. `--dry-run` says what it would resolve and resolves nothing, and
nothing is resolved when publishing is off. Turn it off with `resolveThreads: false` in a config
file or `--no-resolve`. The JSON has a `recheck` block with every verdict and `resolved` counts in
the `publication` block.

### Pushes that change nothing to review

Every review keeps a fingerprint of the reviewed diff, without the files left out of the review
and without the line numbers of its hunks. A new commit whose diff has the same fingerprint as the
last Phada review of the pull request is skipped without calling the AI: a push that only touches
ignored files, or a merge of the base branch that only moves the changed lines, does not trigger a
new review. `--force` reviews anyway and `--dry-run` says it would skip.

### Replaying an earlier commit

`--head <sha>` reviews the pull request as it was at an earlier commit, to see whether this
version of Phada (or your config) finds a problem it missed there:

```bash
phada review owner/repo#123 --head 1e6a005 --dry-run
```

The SHA is a commit of the pull request (at least 7 characters), including one a force-push
replaced. The review gets the diff from the base up to that commit and nothing created after the
moment it became the head:

- reviews, comments, threads and replies written later are left out, Phada's own included;
- the threads from before are shown open and current, on the line where they were written, since
  GitHub keeps no record of when a thread was resolved;
- a check that finished later is shown as still running;
- a native skill reads nothing of the repository on GitHub: it works on the checkout at that
  commit, and `gh pr view`, `gh pr diff` and `gh pr checks` answer from the replay.

The moment is the first force-push that brought the commit. GitHub does not record when a normal
push happened, so otherwise the cut is the commit date, which comes before the push, and the run
warns `The cut is approximate`. The title and the description are the ones of today.

A replay always runs with `--dry-run` (without it Phada refuses: a replay never publishes), never
skips, rechecks and resolves no comment, and does not wait for the checks (`--wait-ci` is
refused). It is kept in the [history](history-and-lessons.md#history) as a replay, which
`phada publish` refuses and the feedback of the comments does not count.
`phada prompt owner/repo#123 --head <sha>` shows the prompt of the replay without calling the AI.
