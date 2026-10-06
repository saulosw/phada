# Phada

> Your repositories. Your rules. Your context. Your AI providers. Your execution strategy.

Phada is an open source orchestrator for AI code review of GitHub pull requests. Phada is not
the AI, and no single AI provider is the product: it connects your repositories, your review
rules and context, the AI provider you choose and the place where the review runs.

It starts local: Phada runs on your machine and uses the AI you already have — an AI CLI you are
logged into and paying for (Claude Code or Codex) or a model served by Ollama — instead of a per-seat review SaaS.

**Status:** early proof of concept. There is nothing to install yet.

## Requirements

- Node.js 22 or newer
- [GitHub CLI](https://cli.github.com/) (`gh`), logged in
- One AI provider:
  - [Claude Code](https://code.claude.com/) (`claude`), logged in with your subscription,
  - [Codex CLI](https://developers.openai.com/codex/cli) (`codex`, install with `npm i -g @openai/codex`, then `codex login`), or
  - [Ollama](https://ollama.com/download), running, with a model pulled (e.g. `ollama pull qwen2.5-coder:7b`)

## Try it

```bash
npm ci
export GITHUB_TOKEN=$(gh auth token)   # older gh without "auth token": gh auth status -t
npm run review -- owner/repo#123
```

Phada fetches the pull request and its diff, asks the AI provider you chose for a review and
prints it as Markdown. Progress goes to stderr and the review to stdout, so
`npm run -s review -- owner/repo#123 > review.md` saves only the review (`-s` keeps npm's own
banner out of the file), and `--format json` prints it as JSON for scripts. A review of a large
pull request can take a few minutes.

### What a review looks like

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
  a suggested fix. Only findings at the confidence cut or above are shown here (60 by default,
  see `--min-confidence`):
  - **P0 · Must fix**: security holes, data loss, crashes, wrong money handling;
  - **P1 · Should fix**: bugs, incorrect behavior, edge cases, race conditions, leaks;
  - **P2 · Consider**: maintainability or design risks with a concrete consequence.
- **Worth checking**: up to five findings with confidence from 50 up to the cut, one line each.
  They do not change the score.
- A footer with how many findings there are, how many are worth checking, how many were dropped
  (rejected by verification, outside the diff, duplicates, below confidence 50, or not in the
  expected shape) and the provider, model, time and tokens.

With `--verify`, the first pass asks the AI for every candidate from confidence 25 instead of 50,
and Phada makes a second call to the same AI before scoring. It sends the pull request, the diff
and the candidates, without their severity and confidence, and asks a skeptical reviewer to
confirm each one, with its own severity and confidence, or reject it. Rejected findings leave the
review and are counted in the footer; `--format json` lists them with the reason. Confirmed
findings still below 50 are dropped like any other. A finding without an answer keeps its first
rating and the footer says how many were left unchecked (`not verified` when none got an answer).
A verified review takes about twice the time and tokens; the time and tokens shown are the total
of both calls.

If the AI's answer is not a valid review, Phada stops with an error instead of printing it;
`--debug` shows the start of the answer.

| Option                 | What it does                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--provider <name>`    | AI provider: `claude` (default), `codex` or `ollama`                                                                                                                                                                                                               |
| `--model <name>`       | Model to use. Required for Ollama. Default: for Claude, the Claude Code default model, else `opus`; for Codex, the `model` in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), else the Codex CLI default                                                    |
| `--language <tag>`     | Language of the review, e.g. `pt-BR`. Default: English                                                                                                                                                                                                             |
| `--min-confidence <n>` | Confidence cut, a whole number from 50 to 100. Findings at the cut or above are shown and scored; the ones from 50 up to the cut are listed as worth checking. Default: 60                                                                                         |
| `--format <name>`      | Output: `markdown` (default) or `json`. The JSON (`schemaVersion: 1`) carries the same review as data: score, summary, every changed file, findings, findings worth checking, dropped counts, the verification (with `--verify`), provider, model, time and tokens |
| `--verify`             | Checks every finding with a second call to the AI before scoring (see above). Off by default                                                                                                                                                                       |
| `--debug`              | Shows error details                                                                                                                                                                                                                                                |

With Claude Code and Codex, the AI runs in an empty temporary directory and only sees the pull
request text that Phada sends. Phada only reads the `model` from their settings. An
`AGENTS.md`/`CLAUDE.md` in or above that temporary directory is never loaded.

Claude Code runs without tools, MCP servers or your personal settings (hooks, plugins, skills,
`CLAUDE.md`).

Codex keeps a few built-in tools enabled that, with Codex CLI 0.160.0, can neither read your
files nor reach the network. Phada also turns off the apps connected to your ChatGPT account,
the shell, web search, plugins and sub-agents, and runs it read-only. Codex adds features
between versions, so the list of disabled features was checked with that version. Codex also
still reads your global `~/.codex/AGENTS.md` (or `$CODEX_HOME/AGENTS.md`) on every review, so
keep it free of instructions you do not want applied to your reviews.

### Local models with Ollama

```bash
ollama pull qwen2.5-coder:7b
npm run review -- owner/repo#123 --provider ollama --model qwen2.5-coder:7b
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

## Scripts

| Script                 | What it does                                                          |
| ---------------------- | --------------------------------------------------------------------- |
| `npm run review`       | Reviews a pull request (see Try it)                                   |
| `npm run dev`          | Same as `npm run review` (runs from source with `tsx`, no build step) |
| `npm run typecheck`    | Type-checks the project with `tsc --noEmit`                           |
| `npm test`             | Runs the test suite with Vitest                                       |
| `npm run format`       | Formats the code with Prettier                                        |
| `npm run format:check` | Checks formatting (used by CI)                                        |

## Security

Tokens are read from environment variables only and are never printed or committed.
Phada never reads or manages the credentials of your AI CLI — authentication belongs to
that tool.
