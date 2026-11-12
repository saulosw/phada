# AI providers

The AI providers Phada runs (Claude Code, Codex CLI and Ollama), what each one needs on your
machine, what the AI sees during a review and what it cannot reach, and how to review with a
local model. Choose the provider with `provider` in your config or `--provider` (see
[Options](commands.md#options)); Claude Code is the default.

## Requirements of each provider

Phada needs one of them:

- [Claude Code](https://code.claude.com/) (`claude`), logged in with your subscription (run
  `claude` and then `/login`).
- [Codex CLI](https://developers.openai.com/codex/cli) (`codex`): install it with
  `npm i -g @openai/codex`, then run `codex login`.
- [Ollama](https://ollama.com/download), running, with a model pulled (e.g.
  `ollama pull qwen2.5-coder:7b`). `:cloud` models also need `ollama signin`.

Phada never reads or manages the credentials of your AI CLI: authentication belongs to that tool.

## What the AI sees

With Claude Code and Codex, the AI runs in an empty temporary directory (a
[native skill](review-context.md#skills-that-run-natively) runs in a checkout of the pull request
instead) and only sees the text that Phada sends:

- the pull request and its diff;
- the rules and docs described in
  [Rules and repository context](review-context.md#rules-and-repository-context);
- its [conversation and checks](review-context.md#conversation-and-ci);
- what it reads with Phada's tools from the pull request head and from the
  [related repositories](review-context.md#related-repositories) (see
  [Repository investigation](review-context.md#repository-investigation)).

Rules from `.phada/` and your config are instructions, and so are the `review.prompt` file and the
text of the skills you name (see [Review focus and skills](review-context.md#review-focus-and-skills)).
The pull request, the diff, the docs, the conversation and the checks are data, and instructions
hidden in them are reported as findings.

Phada only reads the `model` from the settings of the AI CLIs. An `AGENTS.md`/`CLAUDE.md` in or
above that temporary directory is never loaded, and the GitHub token is removed from the
environment of the AI process.

### Claude Code

Claude Code runs without its own tools or your personal settings (hooks, plugins, skills,
`CLAUDE.md`). A skill named in `review.skills` runs natively in a checkout of the pull request with
only that skill or plugin loaded and the limits described in
[Skills that run natively](review-context.md#skills-that-run-natively). The only MCP servers it
can use are Phada's (which also carries the servers declared in `mcp`) and the ones `mcp` names.

Without `--model` or `model` in your config, Phada uses the Claude Code default model
(`ANTHROPIC_MODEL`, or the `model` in `~/.claude/settings.json`, or in
`$CLAUDE_CONFIG_DIR/settings.json`), else `opus`.

### Codex CLI

Codex keeps a few built-in tools enabled that, with Codex CLI 0.160.0, can neither read your files
nor reach the network. Phada also turns off the apps connected to your ChatGPT account, the shell,
web search, plugins and sub-agents, and runs it read-only. Codex adds features between versions,
so the list of disabled features was checked with that version.

Codex also still reads your global `~/.codex/AGENTS.md` (or `$CODEX_HOME/AGENTS.md`) on every
review, so keep it free of instructions you do not want applied to your reviews. Your own MCP
servers stay off unless `mcp` names them (see [MCP servers](review-context.md#mcp-servers)).

Without `--model` or `model` in your config, Phada uses the `model` in `~/.codex/config.toml` (or
`$CODEX_HOME/config.toml`), else the Codex CLI default.

## Local models with Ollama

```bash
ollama pull qwen2.5-coder:7b
phada review owner/repo#123 --provider ollama --model qwen2.5-coder:7b
```

The [setup](terminal-app.md#setup) and the Provider screen of the app can pull the model and choose
it for you. With Ollama, `--model` (or `model` in your config) is required.

Phada talks to Ollama at `127.0.0.1:11434` (or `OLLAMA_HOST`). It checks the model's context
window first and stops with an error when the pull request does not fit: it never lets the model
silently cut the diff. When the prompt carries the conversation or the checks, the error also
suggests leaving them out with `--no-conversation` or `--no-ci`.

- **Local models stay on your machine**, but without a GPU they are slow (minutes even for a small
  pull request) and small models follow instructions hidden in a diff more easily than large ones.
  Use them for small, trusted pull requests.
- **`:cloud` models** (e.g. `gpt-oss:120b-cloud`, after `ollama signin`) run on Ollama's servers:
  the diff leaves your machine. Some of them need paid Ollama credits.
- **A remote `OLLAMA_HOST`** (another machine or a hosted Ollama) also sends the diff off your
  machine, to that server.

Ollama reports no cached tokens, and with Ollama, `phada fix` applies only the suggested changes
and lists the findings left (see [Fixing the findings](commands.md#fixing-the-findings-phada-fix)).
