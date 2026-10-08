# Security policy

## Supported versions

Security fixes go into the latest published `0.x` release of the `phada` npm package.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab
and choose **Report a vulnerability**. Do not open a public issue.

Include what you found, how to reproduce it and what an attacker could do with it. You will get a
first answer within 7 days; fixes are handled on a best-effort basis.

## Scope

Reports are especially welcome about:

- the GitHub token leaking: printed, logged, written to disk or passed to the AI process;
- what Phada sends to an AI provider beyond the pull request it reviews;
- text inside a pull request (code, comments, description) that changes the review, the score or
  what Phada does, beyond being reviewed;
- the isolation of the AI CLI process: the empty temporary directory, the disabled tools and
  settings, and the removal of token variables from its environment.

Problems in the AI CLIs themselves (Claude Code, Codex) or in Ollama belong to those projects.
