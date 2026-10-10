const SHARED_OPTIONS = `# Review options. Flags given on the command line win.
# language: en                 # language of the review, e.g. pt-BR
# minConfidence: 60            # findings below this confidence go to "worth checking"
# verify: true                 # check every finding with a second call to the AI
# investigate: true            # let the AI read the rest of the repository at the head
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

# Files left out of the diff, on top of lockfiles, minified files and source maps.
# ignore: ["**/*.snap", "src/generated/**"]
`

export const REPOSITORY_CONFIG_TEMPLATE = `# Phada config for this repository, read from the base branch of each pull request.
# A .phada/ folder in a subfolder adds rules, files and ignore patterns for that part
# of the tree; options are only read from this root file and from each user's own config.

${SHARED_OPTIONS}
${RULES}
${CONTEXT}`

export const USER_CONFIG_TEMPLATE = `# Your own Phada config. It applies to every review you run, on top of the
# repository's .phada/ folder; a repos/<owner>/<repo>/ folder next to it applies
# to one repository only and wins over this file.

# AI provider and model for your reviews.
# provider: claude             # claude, codex or ollama
# model: opus

${SHARED_OPTIONS}
${RULES}
${CONTEXT}
# Files or folders on this machine to send as context (folders: every .md inside).
# localFiles: ["~/notes/team-rules"]

# MCP servers of your Claude Code that the AI may use during reviews, by name
# (claude.ai connectors as "claude.ai <Name>"). Only with provider claude.
# mcp: [linear]
`

export const RULES_TEMPLATE = `<!--
Rules for the review, in plain Markdown. Everything outside this comment is sent to
the AI as an instruction, e.g.:

- Validate every route parameter with a zod schema.
- Log with request.log, never console.log, in request code.
-->
`
