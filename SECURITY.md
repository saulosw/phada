# Security policy

Security fixes go into the latest published `0.x` release of the `phada` npm package.

## Reporting a vulnerability

Report it privately: open the repository's **Security** tab on GitHub and choose **Report a
vulnerability**. Do not open a public issue. Say what you found, how to reproduce it and what an
attacker could do with it. You get a first answer within 7 days; fixes are best effort.

## Scope

Reports are especially welcome about:

- the GitHub token leaking: printed, logged, written to disk or passed to the AI process;
- what Phada sends to an AI provider beyond the pull request it reviews;
- text inside a pull request (code, comments, description) that changes the review, the score or
  what Phada does, beyond being reviewed;
- the isolation of the AI CLI process: the empty temporary directory, the disabled tools and
  settings, and the token variables removed from its environment;
- the repository investigation: Phada's read-only tools reading anything outside the fetched pull
  request commit, the token reaching `git` arguments or messages, the AI using MCP servers your
  config did not name, or temporary files left behind.

Problems in the AI CLIs themselves (Claude Code, Codex) or in Ollama belong to those projects.
