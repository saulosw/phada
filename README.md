# Phada

> Your repositories. Your rules. Your context. Your AI providers. Your execution strategy.

Phada is an open source orchestrator for AI code review of GitHub pull requests. Phada is not
the AI, and no single AI provider is the product: it connects your repositories, your review
rules and context, the AI provider you choose and the place where the review runs.

It starts local: Phada runs on your machine and uses the AI CLI you are already logged into and
paying for (Claude Code, Codex) instead of a per-seat review SaaS.

**Status:** early proof of concept. There is nothing to install yet.

## Requirements

- Node.js 22 or newer
- [GitHub CLI](https://cli.github.com/) (`gh`), logged in
- [Claude Code](https://code.claude.com/) (`claude`), logged in with your subscription

## Try it

```bash
npm ci
export GITHUB_TOKEN=$(gh auth token)   # older gh without "auth token": gh auth status -t
npm run review -- owner/repo#123
```

Phada fetches the pull request and its diff, asks your AI CLI for a review and prints it.
Progress goes to stderr and the review to stdout, so
`npm run -s review -- owner/repo#123 > review.md` saves only the review (`-s` keeps npm's own
banner out of the file). A review of a large pull request can take a few minutes.

| Option              | What it does                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `--model <name>`    | Model to use. Default: your Claude Code default model, otherwise `opus` |
| `--language <tag>`  | Language of the review, e.g. `pt-BR`. Default: English                  |
| `--provider <name>` | AI provider. Only `claude` for now                                      |
| `--debug`           | Shows error details                                                     |

The AI runs in an empty temporary directory without tools, MCP servers or your personal Claude
Code settings (hooks, plugins, skills, `CLAUDE.md`). Phada only reads the `model` from those
settings. The AI only sees the pull request text that Phada sends.

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
