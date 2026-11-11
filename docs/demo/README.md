# Demo media

The GIFs and the image of the main [README](../../README.md) are made from the scripts in this
folder, so they can be made again when the interface changes:

| File         | What it shows                                                      | Made by                      |
| ------------ | ------------------------------------------------------------------ | ---------------------------- |
| `app.gif`    | The terminal app reviewing a pull request in **Only look** mode    | [`app.tape`](app.tape)       |
| `review.gif` | `phada review saulosw/phada-demo#1 --dry-run` in a terminal        | [`review.tape`](review.tape) |
| `review.png` | What that review would post, rendered as the pull request shows it | [`render.mjs`](render.mjs)   |

All three review [saulosw/phada-demo#1](https://github.com/saulosw/phada-demo/pull/1), a small
public repository whose pull request has a planted bug. Nothing is published on it.

## Make them again

```bash
npm run demo
```

It needs Docker and a GitHub token (`GITHUB_TOKEN`, `GH_TOKEN` or a `gh` login); the token only
reads the public pull request and never shows on screen. The script builds Phada, builds the image
of [`Dockerfile`](Dockerfile) ([VHS](https://github.com/charmbracelet/vhs) with Node and git), and
runs each recording in a container with a config, a cache and a history of its own, so nothing
from your machine appears. It fails when a frame shows the token or a local path.

## The AI answer is replayed

A real review takes minutes and another run of the AI can word its findings differently. So the
recordings do not call an AI: [`replay/claude`](replay/claude) stands in for the `claude` command
and answers each call, after a few seconds, with the output of a real Claude Code run on the same
pull request, kept in [`recording/`](recording/). Everything else (fetching the pull request,
indexing, the impact, validating, verifying and scoring the answer, the output) is Phada running
for real.

To record the answer again, after a change to the prompt or the answer schema, run a real dry run
with [`record/claude`](record/claude) first on the `PATH`. It runs the real `claude`, passes its
output through, and keeps a copy of each answer without the session ids, the account details and
the local paths:

```bash
rm -rf docs/demo/recording
PATH="$PWD/docs/demo/record:$PATH" \
  PHADA_DEMO_REAL_CLAUDE="$(command -v claude)" \
  PHADA_DEMO_RECORDING="$PWD/docs/demo/recording" \
  PHADA_CONFIG_HOME="$(mktemp -d)" PHADA_CACHE_HOME="$(mktemp -d)" PHADA_DATA_HOME="$(mktemp -d)" \
  npm run dev -- review saulosw/phada-demo#1 --dry-run
```
