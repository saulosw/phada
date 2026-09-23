# Phada

> Your repository. Your machine. Your AI. Your rules.

Phada is an open source code review orchestrator for GitHub pull requests. It runs on your
machine and uses the AI CLI you are already logged into and paying for (Claude Code, Codex)
instead of a per-seat review SaaS or a pay-per-call API. Phada is not the AI — it is the
bridge between GitHub, your machine and your AI.

**Status:** early proof of concept. There is nothing to install yet.

## Requirements

- Node.js 22 or newer
- [GitHub CLI](https://cli.github.com/) (`gh`), logged in
- [Claude Code](https://code.claude.com/) (`claude`), logged in with your subscription

## Setup

```bash
npm ci
cp .env.example .env   # optional; or: export GITHUB_TOKEN=$(gh auth token)
npm run dev
```

## Scripts

| Script                 | What it does                                   |
| ---------------------- | ---------------------------------------------- |
| `npm run dev`          | Runs the entrypoint with `tsx` (no build step) |
| `npm run typecheck`    | Type-checks the project with `tsc --noEmit`    |
| `npm test`             | Runs the test suite with Vitest                |
| `npm run format`       | Formats the code with Prettier                 |
| `npm run format:check` | Checks formatting (used by CI)                 |

## Security

Tokens are read from environment variables only and are never printed or committed.
Phada never reads or manages the credentials of your AI CLI — authentication belongs to
that tool.
