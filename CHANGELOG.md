# Changelog

All notable changes to Phada are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Phada uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While Phada is in `0.x`, options and
output can change between minor versions.

## Unreleased

### Added

- Reviews now use the repository's own rules and docs, read from the base commit of the pull
  request: `.phada/config.yml` and `.phada/rules.md` (at the root and in subfolders), and docs
  such as `AGENTS.md`, `CLAUDE.md`, `.claude/rules/`, `CONTRIBUTING.md`, `README.md` and `docs/`,
  within a 60 KB budget that never cuts silently.
- Your own config in `~/.config/phada/` (global, or per repository in `repos/<owner>/<repo>/`)
  sets the provider, model, review options, rules and local docs.
- `phada init` creates the repository config; `phada init --global [owner/repo]` creates yours.
- Lockfiles, minified files and source maps are left out of the diff, and the review names them
  (a pull request with only ignored files gets a short note); `ignore` adds more.
- Findings name the rule they break and the sources they rely on, in the JSON and on the pull
  request; the JSON has a `context` block with everything sent to the AI.
- `--no-verify` turns verification off when the config turns it on.

### Changed

- Releases go through the npm stage and wait for a maintainer's approval.

## 0.1.0 - 2026-10-08

First public release.

### Added

- `phada review <owner/repo#N | pull request URL>` reviews a GitHub pull request with an AI
  provider you already use: Claude Code (`claude`, the default), Codex (`codex`) or a model
  served by Ollama (`ollama`), chosen with `--provider` and `--model`.
- The review has a score from 0 to 5 computed by Phada, a summary, the changed files and findings
  grouped by severity (P0, P1, P2), each with its file, line, confidence, why it matters and a
  suggested fix. Findings always point to a line inside the diff.
- `--min-confidence <n>` sets the confidence cut (50 to 100, default 60); findings below it are
  listed as worth checking.
- `--verify` checks every finding with a second call to the AI before scoring.
- `--format json` prints the review as data (`schemaVersion: 1`).
- `--language <tag>` sets the language of the review; Phada's own labels are in English and
  Portuguese.
- Phada publishes the review on the pull request as the owner of the GitHub token: one comment on
  the line of each finding and the rest in the review body. It skips a commit it already reviewed
  while its threads are open, and does not post again a finding that matches an open thread.
- `--dry-run` prints exactly what would be published and posts nothing; `--force` reviews and
  publishes even when Phada already reviewed the commit.
- The GitHub token is read from `GITHUB_TOKEN` or `GH_TOKEN`.
