# Watch and review requests

How Phada reviews without you running `phada review` each time: `phada watch` follows your
repositories and reviews new pull requests and pushes on its own, and takes review requests from a
script (`phada enqueue`), from your AI (`phada mcp`), from a `/phada review` comment on the pull
request and from Slack. It also sends review events to hooks of your own, and can ask a command of
yours before it reviews. The watch can also run inside the
[terminal app](terminal-app.md#running-the-watch-from-the-app).

## Watch mode

`phada watch` follows the repositories you list in your own config and reviews new pull requests
and new pushes on its own, one at a time, and publishes them like `phada review`. The
[setup](terminal-app.md#setup) and the Repositories screen of the app list them for you; the other
keys are written by hand:

```yaml
# ~/.config/phada/config.yml
watch:
  interval: 5m # how often to look for changes (60s at least)
  settle: 3m # wait after the last push before reviewing
  maxReviewsPerHour: 6
  replies: auto # answer replies in Phada's threads: auto, mention or off
  repos:
    - owner/repo
    - repo: owner/other
      publish: false # keep the review in the history only (and replies: off)
      replies: mention # only replies that call /phada
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

`phada watch --status --format json` prints the same as JSON (`schemaVersion: 1`); `--format` only
applies to `--status`.

### What the watch picks up

- `watch` is only read from your top-level config, never from a repository's `.phada/` or from
  `repos/<owner>/<repo>/config.yml`: a repository cannot make your machine review anything. The
  provider, model, language and the other options of each repository come from the usual config
  files, as with `phada review`.
- The first time the watch sees a repository, the pull requests already open are recorded as they
  are and not reviewed; a new pull request, or a new push on any of them, is. `--backfill` reviews
  the open ones too; on a repository the watch already recorded it has no effect, and the watch
  says so.
- A push is reviewed once the `settle` time has passed since the watch first saw it, so a burst of
  pushes leads to one review of the newest commit. There is one job per pull request and one review
  at a time, at most `maxReviewsPerHour` an hour. When a pull request moves to a newer commit while
  it is being reviewed, the review is kept in the history and not published, and the newer commit
  is reviewed instead. A commit Phada already reviewed is never reviewed again.
- Drafts and pull requests opened by bots are never picked up by the polling (someone can still
  [ask for them](#asking-for-reviews-from-anywhere)). On a public repository, only pull requests of
  owners, members and collaborators are, unless the repository sets `allowExternal: true`: the AI
  runs on that code with nobody watching.

### Waiting for CI

- Before a job starts, the watch reads the [checks](review-context.md#the-checks) of its commit.
  While some are pending, the job waits for CI (`waiting` in `phada watch --status`, with until
  when and the pending checks), read again every minute, for at most `ci.wait` (15 minutes by
  default, `0s` turns it off) after the watch saw the commit; then it is reviewed with the checks
  as they are. A failing check does not end the wait while others are still pending, so the review
  gets the result of the whole pipeline. A commit without any check 2 minutes after the watch saw
  it, or whose checks all ended, is reviewed at once, and so is one whose checks cannot be read
  (with a warning). A push replaces a waiting job like a queued one, a request joins it and reads
  the checks again at once, and waiting does not count in `maxReviewsPerHour`.
- With `ci.onFailure: skip`, a commit whose checks fail is not reviewed: the job is skipped as
  `ci-failing` (in the history, the `review.skipped` event and Slack), its checks are read again
  every `interval` for 24 hours (at most 10 skipped jobs a cycle, the ones read longest ago first),
  and the same job is reviewed once they no longer fail. A request for that commit reads them again
  at once. A new push ends it: the new commit is reviewed on its own, and the requests of the
  skipped one move to it.

### Failures, replies and idle time

- A failure that may pass (network, GitHub 5xx, a provider error) is tried again after 1 minute and
  after 5 minutes; after the third attempt the job is marked failed until a new commit. A provider
  usage limit pauses the queue for 15 minutes (doubling up to 2 hours while it lasts), and the
  GitHub rate limit pauses it until it resets. When the AI CLI is not installed or not logged in, or
  GitHub rejects the token, the watch stops with the error. Nothing is published from a review that
  did not finish.
- The watch also [answers replies](commands.md#answering-replies-phada-reply) in Phada's threads,
  as `phada reply` does. Each cycle it lists the review comments of the repository written since
  the last cycle (one call, with an ETag) and keeps the open pull requests where Phada has published
  comments and someone replied in the history until it has answered them, so a restart or a usage
  limit loses none. It answers at most 10 threads a cycle, oldest first, and the rest waits for the
  next one; replies never count in `maxReviewsPerHour` and never wait in the queue. `replies` sets
  it per repository: `auto` (the default where the repository publishes) answers every reply,
  `mention` only threads where a reply calls `/phada`, and `off` (the default with `publish: false`)
  none. A pause of the queue pauses the replies too; a reply that fails is tried again in the next
  cycle, with a warning.
- With nothing to review, the watch updates the mirror and the
  [map](configuration.md#repository-map) of each default branch when it moved, a minute at a time,
  so reviews start from a warm index. It also reads the threads of the pull requests Phada
  reviewed, for the [history](history-and-lessons.md#what-happened-to-each-comment).
- One watch runs at a time on a machine (a lock in the data folder). The first Ctrl-C lets the
  running review finish and stops; the second stops the AI too and puts the pull request back in
  the queue. To keep it running, start it in tmux or as a service of your own.

## Asking for reviews from anywhere

Besides its own polling, the watch reviews what people and tools ask for. Phada knows nothing
about chat apps or mail: it takes **review requests** through three doors (`phada enqueue`,
`phada mcp` and a `/phada review` comment) plus one built-in client, Slack, and it sends **review
events** to your hooks. Every request goes through the same checks, whatever asked for it, and is
refused with a reason when it fails one:

- the repository is listed under `watch:` in your own config (`not-watched`);
- the pull request is open (`closed`);
- on a public repository, the author is an owner, member or collaborator unless the repository
  sets `allowExternal: true` (`external`);
- the [`when` command](#a-condition-of-your-own) of the repository lets it through
  (`when-command`);
- the commit was not already reviewed (`already-reviewed`, with that review);
- fewer than `maxReviewsPerHour` new reviews were queued in the last hour (`hourly-limit`).

A request for a commit that already has a job waiting or running joins that job: one review, and
everyone who asked hears back. The one exception is a request that publishes while the running job
does not: it gets a review of its own once that one ends. A request is reviewed at once, without
the `settle` time, and the filters of `watch:` (`authors`, `labels`, `baseBranches`, drafts) only
decide what the polling picks up: a draft someone asks for is reviewed. When the pull request gets
a new commit before its review starts, the request moves to the new commit.

Each request says where the review goes: `pr` (the default) publishes it on the pull request,
`none` keeps it in the history and the events only. The review is the same either way.

Requests wait in the queue of `phada watch`, which runs them; with no watch running they wait until
one starts.

### From a script: `phada enqueue`

```bash
phada enqueue owner/repo#123                 # exit 0 when queued or joined, 1 when refused
phada enqueue owner/repo#123 --publish none  # review it without posting on the pull request
phada enqueue owner/repo#123 --format json
```

It takes `owner/repo#N` or the URL of the pull request, and needs a GitHub token to read it. For
example, from cron every morning: `0 9 * * 1-5 phada enqueue acme/shop#42 --publish none`.

### From your AI: `phada mcp`

`phada mcp` is an MCP server over stdio. Add it to your AI CLI, for instance
`claude mcp add phada -- phada mcp`, and the AI can ask for a review and wait for the answer:

| Tool                    | What it does                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review_pull_request`   | `pr` (`owner/repo#N` or a URL) and `publish` (`pr` or `none`): queues the review, joins the one already queued, or says why it was refused                                                          |
| `job_status`            | The state of a job, its place in the queue and, once it ended, its event                                                                                                                            |
| `wait_for_job`          | Waits until the job ends (`timeoutSeconds`, 300 by default, 1800 at most) and returns its event with the full review                                                                                |
| `list_queue`            | The jobs waiting and the one running                                                                                                                                                                |
| `review_local_changes`  | `base` and `uncommitted`: starts a [review of the branch](commands.md#your-branch-before-the-pull-request) checked out in the folder `phada mcp` runs in, and answers its id at once; one at a time |
| `wait_for_local_review` | Waits until that review ends (`timeoutSeconds`, 300 by default, 1800 at most) and returns its JSON, the id of the saved run and its warnings                                                        |

The AI asks; Phada decides. A message that talks the AI into asking for a review of some other
repository is refused like any other request. The local review tools let your coding agent review
its own branch before it opens the pull request, and publish nothing; they do not need the watch.
`phada mcp` needs a GitHub token (`GITHUB_TOKEN`, `GH_TOKEN` or the `gh` login) to read the pull
requests asked for.

### From the pull request: `/phada review`

An owner, member or collaborator of a watched repository can comment `/phada review` (as the first
line) on a pull request. The watch reads the new comments of each repository once per `interval`,
reacts with 👀 to the ones it takes and reviews the pull request; the review is published on it.
Comments from anyone else, from bots, or older than when the watch first saw the repository are
ignored.

### Slack

With `slack:` in your own config, `phada watch` also listens to the Slack channels you list (Socket
Mode, so no public URL is needed) and reviews the pull requests linked in their messages:

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
environment.

A message with up to five pull request links of watched repositories gets ⏳ and, when each review
ends, the emoji of its verdict and an answer in its thread:

- `link`: the verdict and the links;
- `summary`: plus the summary, the score and the counts;
- `full`: plus every finding with a link to its line in the reviewed commit, split into several
  messages when long.

A commit Phada already reviewed is answered with the link of that review. A commit skipped for
[failing CI](#waiting-for-ci) gets the `skipped` emoji and
`CI failing: test, lint. It is reviewed once these checks pass.`; once it is reviewed, that emoji
gives way to the verdict's. A refused request is answered with the reason; messages in other
channels, from bots, or with links to repositories outside `watch:` are left alone.

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

Each hook is a shell command run from your config folder, with your environment (tokens included,
as in your own shell: do not let a hook print it), for the jobs of the queue. It gets the event as
JSON on stdin (`schemaVersion: 1`):

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

- `source` is `watch`, `enqueue`, `mcp`, `pr-command` or `slack`, and `data` is what that source
  brought.
- `review` comes with `review.finished`, `reason` with `review.skipped` (`superseded`, `closed`,
  `already-reviewed`, `ci-failing`, …) and `error` with `review.failed`, which is only sent once
  the job gave up.
- `ci` is the state of the [checks](review-context.md#the-checks) (`none`, `pending`, `passing` or
  `failing`) and each check that counts, once the review or the watch read them (in
  `review.started`, as the watch read them before starting the review); `null` when the checks
  were not read.

A hook that fails or runs out of time is reported in the watch and never stops it.

The **verdict** is computed by Phada from the findings, never by the AI: `blocking` when a finding
is P0 or P1, `comments` when there are only P2 findings or findings worth checking, `clean` when
there is nothing, `failed` and `skipped`. It is also in the JSON of every review and in the
history.

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

The command runs like a hook and gets the pull request and the request as JSON on stdin. It has 10
seconds to exit: 0 lets the request through; anything else, an error or no answer refuses it, with
the first line the command wrote to stderr as the reason. It runs before a new review is queued,
for a request or for a push the polling finds; a request that joins a job or finds the commit
already reviewed does not ask it, and a refused push is not asked again until a new commit.

### Recipes

- **Slack through your AI:** with a Slack MCP server and `phada mcp` in your AI CLI, ask it to watch
  a channel, call `review_pull_request` with `publish: none` for each pull request link,
  `wait_for_job`, and post the findings it gets back in the thread.
- **Teams, mail or anything with a webhook:** a `review.finished` hook that posts the event, e.g.
  `jq '{text: "\(.job.url): \(.verdict)"}' | curl -s -H 'Content-Type: application/json' -d @- "$TEAMS_WEBHOOK_URL"`.
- **A schedule:** `phada enqueue` from cron, as [above](#from-a-script-phada-enqueue).
