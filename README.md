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

- Node.js 22 or newer
- `git`, for the repository investigation (without it, the AI only sees the diff and the context)
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

`phada --help` lists the commands and `phada review --help` lists the review options.

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
  a suggested fix. Confidence is how sure the AI is that the problem is real and happens as
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

With `--verify`, the first pass asks the AI for every candidate from confidence 25 instead of 50,
and Phada makes a second call to the same AI before scoring. It sends the pull request, the diff
and the candidates, without their severity and confidence, and asks a skeptical reviewer to
confirm each one, with its own severity and confidence, or reject it. Rejected findings leave the
review and are counted in the footer; `--format json` lists them with the reason, and gives the
verifier's reason for every confirmed finding too (`null` for a finding it did not check). Confirmed
findings still below 50 are dropped like any other. A finding without an answer keeps its first
rating and the footer says how many were left unchecked (`not verified` when none got an answer).
A verified review takes about twice the time and tokens; the time and tokens shown are the total
of both calls.

If the AI's answer is not a valid review, Phada stops with an error instead of printing it;
`--debug` shows the start of the answer.

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
| Exists, it had findings and every thread is resolved   | Reviews and publishes again                              |
| Exists and found nothing                               | Skips: "already reviewed by Phada; nothing was found"    |

`--force` always reviews; `--dry-run` never skips and says what a real run would do. A skipped run
exits with 0 and does not call the AI.

After a new push, a finding that matches an open Phada thread (same file, and the same title or a
line within three of it) is not posted again as a comment: the review body lists it under "Still
open from previous reviews", so it never disappears from the pull request. When every finding is
still open, Phada posts only a short note saying there is nothing new and how many findings remain
open. Resolved threads never block a finding.

Text written by the AI cannot mention anyone, link other issues or pull requests (`#12`, `owner/repo#12`), add HTML or forge Phada's own markers, and a body
longer than GitHub allows is shortened with a visible "(truncated)". Two runs on the same pull
request at the same time can both publish. GitHub refuses a new review while you have a pending
review of your own open in its interface; submit or discard it first.

## Rules and repository context

Besides the diff, every review gets context from the repository and from your own config. All
of it is read from the **base commit** of the pull request, so a pull request cannot change the
rules that review it.

- **Rules** from `.phada/` in the repository and from your own config (see
  [Configuration](#configuration)). They reach the AI as instructions: a change that breaks one
  is a finding that names the rule, and a rule can set the lowest severity of those findings.
- **Docs** the AI reads as reference, in this order: the files your config lists; `README.md`,
  `AGENTS.md` and `CLAUDE.md` in the folders of the changed files and above them; `AGENTS.md`,
  `CLAUDE.md`, `.claude/CLAUDE.md` and `.claude/rules/` at the root; `CONTRIBUTING.md` and
  `README.md`; then the other Markdown files at the root and in `docs/` (changelogs, licenses and
  codes of conduct are left out). Docs share a 60 KB budget; a doc over 20 KB is cut at a line
  with a visible note, and what does not fit is left out. Nothing is cut or left out silently.
- **Ignored files**: lockfiles, minified files and source maps never reach the AI; `ignore` in
  the config adds more patterns. The review names every file it left out, so a change hidden in one of them is still visible to whoever reads it; when every changed file is ignored, Phada posts a short note that names them instead of a review.

Phada prints what it sent before the review, e.g.
`Context: 2 rules · 5 docs (21.3 KB, 1 omitted) · 1 file ignored`. With `--dry-run` the preview
ends with the full list, and the JSON has a `context` block with every rule, doc and ignored file,
where it came from and whether it was sent. Findings list the docs and files they rely on and the
rule they break, in the JSON and under each comment on the pull request.

## Repository investigation

The AI can also read the rest of the repository while it reviews: who calls a function the
pull request changes, what a function it uses does, what the rest of a changed file does. Phada
fetches the head commit of the pull request into a temporary folder (`git fetch --depth 1`, with
the GitHub token only in the environment of `git`) and gives the AI three tools of its own:

- `read_file`: up to 400 lines of a file per call, with line numbers;
- `grep`: a regular expression over the repository, up to 100 matching lines;
- `list`: the entries of a folder.

The tools only read that commit: no path outside the repository, no symbolic link, no binary or
file over 1 MB. Each review pass gets up to 40 calls and 512 KB of results; the verifier
(`--verify`) investigates too, with its own budget. What the tools return comes from the pull
request head, written by its author, so it is data for the AI, never instructions. Findings still
point to a line of the diff, and the files the AI read to support them show up in their sources.
The temporary folder is removed after the review.

Claude Code and Codex reach the tools through a local MCP server that Phada runs for the review;
their own tools stay off. Ollama models use tool calling; a model that does not support it
reviews without the investigation, with a warning.

After the review Phada prints what the AI read, e.g. `Investigated: 6 reads, 3 searches (41.2 KB)`.
With `--dry-run` the preview lists every call, and the JSON has an `investigation` block with
each call, its size and whether a finding used it. `--no-investigate` (or `investigate: false`)
reviews the diff and the context only. Without `git`, or when the head cannot be fetched, the
review runs without the investigation and says why.

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
verify: false
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
```

| Key                | What it does                                                                                                                                 | Where       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `provider`         | `claude`, `codex` or `ollama`                                                                                                                | your config |
| `model`            | Model for that provider                                                                                                                      | your config |
| `localFiles`       | Files or folders on your machine to send as docs (a folder sends every `.md` in it); relative paths start at the folder of that `config.yml` | your config |
| `language`         | Review language, like `--language`                                                                                                           | both (root) |
| `minConfidence`    | Confidence cut, like `--min-confidence`                                                                                                      | both (root) |
| `verify`           | Verify findings, like `--verify`                                                                                                             | both (root) |
| `investigate`      | `false` turns the [repository investigation](#repository-investigation) off, like `--no-investigate`                                         | both (root) |
| `mcp`              | Names of your Claude Code MCP servers the AI may use (see [Your AI's MCP servers](#your-ais-mcp-servers))                                    | your config |
| `context.defaults` | `false` sends only the files listed in `context.files`, not the docs Phada picks                                                             | both (root) |
| `context.files`    | Files of the repository to always send (globs allowed), first in line for the budget                                                         | both        |
| `ignore`           | More files to leave out of the diff                                                                                                          | both        |
| `rules`            | Rules with `rule`, and optionally `id`, `scope` (globs) and `severity` (`P0`, `P1` or `P2`)                                                  | both        |
| `disabledRules`    | Ids of rules from other config files to turn off; from a subfolder's `.phada/`, only inside that folder                                      | both        |

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

| Option                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--provider <name>`    | AI provider: `claude` (default, unless your config sets one), `codex` or `ollama`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--model <name>`       | Model to use. Required for Ollama. Default: for Claude, the Claude Code default model, else `opus`; for Codex, the `model` in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), else the Codex CLI default                                                                                                                                                                                                                                                                                                                                                          |
| `--language <tag>`     | Language of the review, e.g. `pt-BR`. The AI writes its text in it, and Phada's own headings and labels follow it in English (`en`) and Portuguese (`pt`, `pt-BR`); other languages keep those labels in English. Default: English                                                                                                                                                                                                                                                                                                                                       |
| `--min-confidence <n>` | Confidence cut, a whole number from 50 to 100. Findings at the cut or above are shown and scored; the ones from 50 up to the cut are listed as worth checking. Default: 60                                                                                                                                                                                                                                                                                                                                                                                               |
| `--format <name>`      | Output: `markdown` (default) or `json`. The JSON (`schemaVersion: 1`) carries the same review as data: score, summary, every changed file, findings, findings worth checking, dropped counts, the verification (with `--verify`), provider, model, time and tokens, a `publication` block (`published` with the URL, `failed`, `dry-run` with the exact body and comments, or `skipped`), a `context` block (see [Rules and repository context](#rules-and-repository-context)) and an `investigation` block (see [Repository investigation](#repository-investigation)) |
| `--no-investigate`     | Reviews without letting the AI read the rest of the repository (see [Repository investigation](#repository-investigation)); `--investigate` turns it back on when the config turns it off                                                                                                                                                                                                                                                                                                                                                                                |
| `--verify`             | Checks every finding with a second call to the AI before scoring (see above). Off by default; `--no-verify` turns it off when the config turns it on                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--dry-run`            | Prints exactly what would be published (the review body and every comment) and posts nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--force`              | Reviews and publishes even when Phada already reviewed this commit (see [Publishing](#publishing))                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--debug`              | Shows error details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Exit codes

| Code | Meaning                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | The review was published (or printed with `--dry-run`), Phada skipped a commit it already reviewed, or the pull request has no changes to review (or only ignored files) |
| 1    | Something failed: GitHub, the AI provider, an answer that is not a review, or publishing (the review is printed first)                                                   |
| 2    | The command line or your own config is wrong (unknown option, invalid pull request reference, invalid `config.yml`, …)                                                   |

## What the AI sees

With Claude Code and Codex, the AI runs in an empty temporary directory and only sees the text
that Phada sends: the pull request, its diff, the rules and docs described in
[Rules and repository context](#rules-and-repository-context), and what it reads with Phada's
tools from the pull request head (see [Repository investigation](#repository-investigation)). Rules from `.phada/` and your
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
