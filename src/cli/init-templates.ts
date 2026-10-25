const SHARED_OPTIONS = `# Review options. Flags given on the command line win.
# language: en                 # language of the review, e.g. pt-BR
# minConfidence: 60            # findings below this confidence go to "worth checking"
# verify: true                 # check every finding with a second call to the AI
# investigate: true            # let the AI read the rest of the repository at the head
# resolveThreads: true         # recheck Phada's earlier comments and resolve the fixed ones
# conversation: true           # send the comments, reviews and threads of the pull request
# ci:
#   read: true                 # read the checks of the head: CI for the AI and the CI line
#   wait: 15m                  # how long the watch waits for pending checks (0s: no wait)
#   onFailure: review          # failing checks: review anyway, or skip until they pass
#   checks: [test, "lint/*"]   # the checks that count, by name or glob (default: all)
`

const RULES = `# Rules the review enforces. Each one is sent to the AI as an instruction.
# rules:
#   - id: orm-only             # optional; lets a subfolder or your config disable it
#     rule: Use the ORM for every query; never build SQL by hand.
#     scope: ["**/*.py"]        # optional; which files it applies to
#     severity: P1             # optional; the lowest severity of a finding that breaks it
# disabledRules: [no-console]  # ids of rules from other config files to turn off
`

const CONTEXT = `# Files the review reads for context, besides the repository docs it picks itself
# (README, AGENTS.md, CLAUDE.md, CONTRIBUTING.md, docs/ and the docs next to the change).
# context:
#   defaults: true             # set to false to send only the files listed below
#   files:
#     - path: docs/architecture.md
#     - path: prisma/schema.prisma
#   repos:                     # other repositories the review may read (up to 7 per review)
#     - acme/web
#     - repo: acme/sdk
#       description: SDK that wraps this API

# Files left out of the diff, on top of lockfiles, minified files and source maps.
# ignore: ["**/*.snap", "src/generated/**"]
`

function reviewFocus(promptFile: string, own = false): string {
  return `# What the reviewer looks for. prompt adds to (append, the default) or replaces
# (replace) Phada's own focus; the output format and the scales stay Phada's.
# skills names skills installed for your AI CLI (plugin:skill for a plugin), one
# review pass each; phada is the built-in reviewer; paths limits a skill to some files.
# With Claude Code a skill runs as /<name> in a checkout of the pull request;
# { name: x, mode: text } sends its text instead; claude:<name> is built into Claude Code.
# review:
#   prompt:
#     file: ${promptFile}
#     mode: append
#   skills: [phada, security-review]
${own ? OWN_REVIEW_OPTIONS : ''}`
}

const OWN_REVIEW_OPTIONS = `#   commands: read-only        # or a list like ["npm test"], or all: these run code of the pull request
#   readDirs: ["~/review-rules"]   # folders a skill may read besides the checkout and its own folder
#   timeout: 30m               # how long one skill may run
`

export const REPOSITORY_CONFIG_TEMPLATE = `# Phada config for this repository, read from the base branch of each pull request.
# A .phada/ folder in a subfolder adds rules, files and ignore patterns for that part
# of the tree; options are only read from this root file and from each user's own config.

${SHARED_OPTIONS}
${reviewFocus('.phada/review.md')}
${RULES}
${CONTEXT}`

export const USER_CONFIG_TEMPLATE = `# Your own Phada config. It applies to every review you run, on top of the
# repository's .phada/ folder; a repos/<owner>/<repo>/ folder next to it applies
# to one repository only and wins over this file.

# AI provider and model for your reviews.
# provider: claude             # claude, codex or ollama
# model: opus

${SHARED_OPTIONS}
${reviewFocus('review.md               # next to this file', true)}
${RULES}
${CONTEXT}
# Let the review read a private related repository for a public pull request
# (what the AI reads there may end up in the published review).
# context:
#   privateOnPublic: true

# Files or folders on this machine to send as context (folders: every .md inside).
# localFiles: ["~/notes/team-rules"]

# MCP servers the AI may use during reviews: named as your Claude Code or Codex shows
# them (claude.ai connectors as "claude.ai <Name>"), or declared here for any provider.
# Secrets come from environment variables. Never used for pull requests from outside
# authors.
# mcp:
#   - linear
#   - name: tickets
#     command: npx
#     args: [-y, '@acme/tickets-mcp']
#     env: { TICKETS_TOKEN: '\${TICKETS_TOKEN}' }
#     description: The ticket cited in the pull request title
`

export const RULES_TEMPLATE = `<!--
Rules for the review, in plain Markdown. Everything outside this comment is sent to
the AI as an instruction, e.g.:

- Validate every route parameter with a zod schema.
- Log with request.log, never console.log, in request code.
-->
`
