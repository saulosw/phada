import { parseArgs } from 'node:util'
import type { ParseArgsOptionsConfig } from 'node:util'
import { InvalidPullRequestRefError } from '../github/errors.js'
import { parsePullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import { DEFAULT_MIN_CONFIDENCE } from '../review/run-review.js'
import { CONFIDENCE_FLOOR, isConfidenceCut, MAX_CONFIDENCE } from '../review/select-findings.js'
import { LANGUAGE_TAG, SKILL_NAME } from '../config/schema.js'
import { DURATION, durationMs } from '../config/duration.js'
import type { PublishTarget } from '../watch/types.js'
import { UsageError } from './errors.js'

export type OutputFormat = 'markdown' | 'json'
export type IndexFormat = 'text' | 'json'

export interface RepositoryName {
  owner: string
  repo: string
}

export type RulesTarget =
  { kind: 'pull'; ref: PullRequestRef } | { kind: 'repo'; repo: RepositoryName }

export type CliCommand =
  | { kind: 'help'; text: string }
  | { kind: 'version' }
  | { kind: 'init'; global: boolean; repo?: RepositoryName }
  | { kind: 'index'; repo: RepositoryName; ref?: string; format: IndexFormat; debug: boolean }
  | { kind: 'rules'; target: RulesTarget; format: IndexFormat; debug: boolean }
  | {
      kind: 'watch'
      once: boolean
      backfill: boolean
      status: boolean
      format: IndexFormat
      debug: boolean
    }
  | {
      kind: 'history'
      target?: RulesTarget
      sinceMs?: number
      limit: number
      stats: boolean
      refresh: boolean
      format: IndexFormat
      debug: boolean
    }
  | { kind: 'history-prune'; olderThanMs: number; debug: boolean }
  | { kind: 'mcp'; debug: boolean }
  | {
      kind: 'enqueue'
      ref: PullRequestRef
      publish: PublishTarget
      format: IndexFormat
      debug: boolean
    }
  | {
      kind: 'prompt'
      target: { kind: 'pull'; ref: PullRequestRef } | { kind: 'default' }
      skills?: string[]
      format: IndexFormat
      debug: boolean
    }
  | {
      kind: 'review'
      ref: PullRequestRef
      provider?: string
      model?: string
      language?: string
      minConfidence?: number
      format: OutputFormat
      verify?: boolean
      investigate?: boolean
      resolveThreads?: boolean
      conversation?: boolean
      skills?: string[]
      dryRun: boolean
      force: boolean
      debug: boolean
    }

export const DEFAULT_HISTORY_LIMIT = 50
const MIN_PRUNE_MS = durationMs('1d')
const MAX_AGE_MS = durationMs('36500d')

export const USAGE = `Usage: phada <command> [options]

Reviews GitHub pull requests with the AI provider you choose.

Commands:
  review <pull request>  Review a pull request and publish the review on it
  init                   Create config files for Phada
  index <owner/repo>     Build a map of a repository's code on this machine
  rules <owner/repo[#N]> Show the rules and docs a review would read
  prompt <pull request>  Show the prompt a review would send, without the AI
  watch                  Review new pull requests and pushes on its own
  enqueue <pull request> Ask the watch to review a pull request
  mcp                    Let your AI ask for reviews: an MCP server over stdio
  history                Show past reviews and what happened to Phada's comments

Options:
  -h, --help             Show this help
  -v, --version          Show the version

Run "phada review --help", "phada rules --help" and so on for the options of each
command.`

export const ENQUEUE_USAGE = `Usage: phada enqueue <owner/repo#N | pull request URL> [options]

Asks the watch to review a pull request now. The request goes through the same
checks as every other: the repository must be listed under watch: in your config,
an outside author is refused unless allowExternal is set, a commit already
reviewed is not reviewed again, and no more than maxReviewsPerHour new reviews
are queued in an hour. A running phada watch picks the job up; without one it
waits in the queue. Exits with 1 when the request is refused.

Options:
  --publish <target>   Where the review goes: pr (on the pull request) or none
                       (only the history and the events) (default: pr)
  --format <name>      Output: text or json (default: text)
  --debug              Show error details
  -h, --help           Show this help

Environment:
  GITHUB_TOKEN         GitHub token used to read the pull request
  GH_TOKEN             Used when GITHUB_TOKEN is not set`

export const MCP_USAGE = `Usage: phada mcp

An MCP server over stdio for the AI you already use: it can ask for a review
(review_pull_request), follow it (job_status, list_queue) and wait for its
verdict and findings (wait_for_job). Requests go through the same checks as
phada enqueue and wait in the queue of phada watch, which runs them. Add it to
your AI CLI, e.g. claude mcp add phada -- phada mcp

Options:
  --debug              Show error details
  -h, --help           Show this help

Environment:
  GITHUB_TOKEN         GitHub token used to read the pull requests asked for
  GH_TOKEN             Used when GITHUB_TOKEN is not set`

export const REVIEW_USAGE = `Usage: phada review <owner/repo#N | pull request URL> [options]

Reviews a GitHub pull request with the AI provider you choose and publishes the
review on it as the owner of the GitHub token: one review with a comment on the
line of each finding. Use --dry-run to only print it.

Options:
  --provider <name>     AI provider: claude, codex or ollama (default: claude)
  --model <name>        Model (required for ollama; otherwise the model set in the
                        provider's own config; for claude, opus when none is set)
  --language <tag>      Review language, e.g. pt-BR (default: English)
  --min-confidence <n>  Confidence cut from ${CONFIDENCE_FLOOR} to ${MAX_CONFIDENCE} (default: ${DEFAULT_MIN_CONFIDENCE}); findings
                        below it are listed as worth checking
  --format <name>       Output: markdown or json (default: markdown)
  --no-verify           Skip the second call to the AI that checks every finding
                        (on by default; it adds about half the time and doubles the
                        tokens)
  --verify              Check the findings, even if your config turns it off
  --no-investigate      Review the diff and the context only, without letting the AI
                        read the rest of the repository
  --investigate         Let the AI read the repository, even if your config turns it off
  --no-resolve          Do not recheck Phada's comments from previous commits, nor
                        resolve the ones whose problem was fixed
  --no-conversation     Do not send the comments, reviews and threads of the pull
                        request to the AI
  --skill <name>        Review with this skill installed for your AI CLI (plugin:skill
                        for a skill of a plugin; phada is the built-in reviewer);
                        repeat it for several passes; replaces review.skills of the config
  --dry-run             Print what would be published and post nothing
  --force               Review again even if Phada already reviewed this commit
  --debug               Show error details
  -h, --help            Show this help

Config:
  Options can also come from .phada/config.yml in the repository and from your
  own config (see "phada init --help"); flags win.

Environment:
  GITHUB_TOKEN          GitHub token that can read the pull request and the
                        repository contents and write reviews, e.g.
                        export GITHUB_TOKEN=$(gh auth token)
  GH_TOKEN              Used when GITHUB_TOKEN is not set
  OLLAMA_HOST           Ollama address (default: 127.0.0.1:11434)
  PHADA_CONFIG_HOME     Folder of your own config (default: ~/.config/phada)`

export const INIT_USAGE = `Usage: phada init [--global [<owner/repo>]]

Creates commented config files for Phada and never overwrites existing ones.

  phada init                      .phada/config.yml and .phada/rules.md in this
                                  repository, shared with everyone who clones it
  phada init --global             your own config, for every repository
  phada init --global owner/repo  your own config for one repository, kept on
                                  this machine

Options:
  --global    Create your own config instead of the repository's
  -h, --help  Show this help`

export const INDEX_USAGE = `Usage: phada index <owner/repo> [options]

Builds or updates a map of the repository's code on this machine: files,
functions, classes, methods, parameters, variables, imports, exports and calls,
for TypeScript, JavaScript, Python and Go. Only files that changed since the
last run are read again.

Options:
  --ref <ref>        Branch, tag or full commit SHA to index (default: the
                     default branch)
  --format <name>    Output: text or json (default: text)
  --debug            Show error details
  -h, --help         Show this help

Environment:
  GITHUB_TOKEN       GitHub token that can read the repository contents
  GH_TOKEN           Used when GITHUB_TOKEN is not set
  PHADA_CACHE_HOME   Folder of the mirror and the index (default: ~/.cache/phada)`

export const RULES_USAGE = `Usage: phada rules <owner/repo[#N] | pull request URL> [options]

Shows what a review reads besides the diff, without calling the AI: config
files, rules with their origin and scope, docs and why each one was sent or left
out, and ignored files.

  phada rules owner/repo#N   the context the review of that pull request gets
  phada rules owner/repo     everything on the default branch, without
                             checking scopes against changed files

Options:
  --format <name>    Output: text or json (default: text)
  --debug            Show error details
  -h, --help         Show this help

Environment:
  GITHUB_TOKEN       GitHub token that can read the repository contents
  GH_TOKEN           Used when GITHUB_TOKEN is not set
  PHADA_CONFIG_HOME  Folder of your own config (default: ~/.config/phada)`

export const PROMPT_USAGE = `Usage: phada prompt <owner/repo#N | pull request URL> [options]
       phada prompt --default [options]

Shows the prompt a review would send to the AI, without calling it: for each
review pass (each skill), the instructions with where each part comes from (the
built-in reviewer, review.prompt, a skill, the rules) and the size of the data
blocks (pull request, docs, diff).

Options:
  --default          Show the built-in prompt, without a pull request or a token
  --skill <name>     Show the passes of these skills instead of review.skills;
                     repeat it for several
  --format <name>    Output: text or json (default: text)
  --debug            Show error details
  -h, --help         Show this help

Environment:
  GITHUB_TOKEN       GitHub token that can read the pull request and the
                     repository contents
  GH_TOKEN           Used when GITHUB_TOKEN is not set
  PHADA_CONFIG_HOME  Folder of your own config (default: ~/.config/phada)`

export const WATCH_USAGE = `Usage: phada watch [options]

Follows the repositories listed under watch: in your own config and reviews new
pull requests and new pushes on its own, one at a time, after a settle time. It
publishes like phada review and keeps every review in a local history. Pull
requests already open when the watch first sees a repository are recorded as
they are, not reviewed. Runs in the foreground: Ctrl-C once lets the running
review finish, twice stops it.

Options:
  --once             Run one cycle and exit (for cron)
  --backfill         Also review the pull requests already open the first time
                     a repository is seen
  --status           Show the queue, the reviews in progress, failures and the
                     last review of each repository, then exit
  --format <name>    Output of --status: text or json (default: text)
  --debug            Show error details
  -h, --help         Show this help

Config (in ~/.config/phada/config.yml):
  watch:
    interval: 5m           # how often to look for changes, 60s at least
    settle: 3m             # wait after the last push before reviewing
    maxReviewsPerHour: 6
    repos:
      - owner/repo
      - repo: owner/other
        publish: false     # keep the review in the history only
        allowExternal: true
        authors: [alice]
        labels: [phada]
        baseBranches: [main]

Environment:
  GITHUB_TOKEN       GitHub token that can read the pull requests and the
                     repository contents and write reviews
  GH_TOKEN           Used when GITHUB_TOKEN is not set
  PHADA_CONFIG_HOME  Folder of your own config (default: ~/.config/phada)
  PHADA_DATA_HOME    Folder of the history (default: ~/.local/share/phada)
  PHADA_CACHE_HOME   Folder of the mirrors and indexes (default: ~/.cache/phada)`

export const HISTORY_USAGE = `Usage: phada history [<owner/repo[#N]>] [options]
       phada history prune --older-than <age>

Shows the reviews kept in the local history and what happened to the
comments Phada published: fixed, dismissed (resolved without a change),
ignored (left open until the pull request closed) or still open, and which
ones got a negative reaction or a reply. Reads only this machine, unless
--refresh.

Options:
  --since <age>        Only the last <age>, e.g. 30d, 12h
  --limit <n>          Show at most n reviews (default: ${DEFAULT_HISTORY_LIMIT})
  --stats              What happened to the comments, per repository
  --refresh            Read the comments' current state on GitHub first
  --format <name>      Output: text or json (default: text)
  --older-than <age>   With prune: remove reviews, findings and finished
                       jobs older than <age>, 1d at least
  --debug              Show error details
  -h, --help           Show this help

Environment:
  GITHUB_TOKEN         GitHub token for --refresh
  GH_TOKEN             Used when GITHUB_TOKEN is not set
  PHADA_DATA_HOME      Folder of the history (default: ~/.local/share/phada)`

const REPOSITORY_NAME = /^([\w.-]+)\/([\w.-]+)$/

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [command, ...rest] = argv
  if (command === 'review') return parseReviewArgs(rest)
  if (command === 'init') return parseInitArgs(rest)
  if (command === 'index') return parseIndexArgs(rest)
  if (command === 'rules') return parseRulesArgs(rest)
  if (command === 'prompt') return parsePromptArgs(rest)
  if (command === 'watch') return parseWatchArgs(rest)
  if (command === 'history') return parseHistoryArgs(rest)
  if (command === 'enqueue') return parseEnqueueArgs(rest)
  if (command === 'mcp') return parseMcpArgs(rest)
  if (command !== undefined && !command.startsWith('-')) throw unknownCommand(command)

  const { values } = parseOptions(argv, {
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
  })
  if (values.help) return { kind: 'help', text: USAGE }
  if (values.version) return { kind: 'version' }
  throw new UsageError('Missing the command, e.g. phada review owner/repo#123.')
}

function unknownCommand(command: string): UsageError {
  if (isPullRequestRef(command)) {
    return new UsageError(`Unknown command "${command}". Did you mean "phada review ${command}"?`)
  }
  return new UsageError(
    `Unknown command "${command}". Available: review, init, index, rules, prompt, watch, enqueue, mcp, history.`,
  )
}

function isPullRequestRef(input: string): boolean {
  try {
    parsePullRequestRef(input)
    return true
  } catch (error) {
    if (error instanceof InvalidPullRequestRefError) return false
    throw error
  }
}

function parseReviewArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseOptions(argv, REVIEW_OPTIONS)
  if (values.help) return { kind: 'help', text: REVIEW_USAGE }

  const [input, ...extra] = positionals
  if (input === undefined) throw new UsageError('Missing the pull request to review.')
  if (extra.length > 0) throw new UsageError('Review one pull request at a time.')
  if (values.model?.trim() === '') throw new UsageError('--model needs a model name.')
  if (values.language !== undefined && !LANGUAGE_TAG.test(values.language)) {
    throw new UsageError(`Invalid --language "${values.language}". Use a tag like en or pt-BR.`)
  }
  const minConfidence = parseMinConfidence(values['min-confidence'])
  if (!isOutputFormat(values.format)) {
    throw new UsageError(`Invalid --format "${values.format}". Use markdown or json.`)
  }

  if (values.verify === true && values['no-verify'] === true) {
    throw new UsageError('Use either --verify or --no-verify.')
  }
  const verify = values.verify === true ? true : values['no-verify'] === true ? false : undefined
  if (values.investigate === true && values['no-investigate'] === true) {
    throw new UsageError('Use either --investigate or --no-investigate.')
  }
  const investigate =
    values.investigate === true ? true : values['no-investigate'] === true ? false : undefined
  const skills = parseSkills(values.skill)

  return {
    kind: 'review',
    ref: parsePullRequestRef(input),
    ...(values.provider === undefined ? {} : { provider: values.provider }),
    ...(values.model === undefined ? {} : { model: values.model.trim() }),
    ...(values.language === undefined ? {} : { language: values.language }),
    ...(minConfidence === undefined ? {} : { minConfidence }),
    format: values.format,
    ...(verify === undefined ? {} : { verify }),
    ...(investigate === undefined ? {} : { investigate }),
    ...(values['no-resolve'] === true ? { resolveThreads: false } : {}),
    ...(values['no-conversation'] === true ? { conversation: false } : {}),
    ...(skills === undefined ? {} : { skills }),
    dryRun: values['dry-run'],
    force: values.force,
    debug: values.debug,
  }
}

const REVIEW_OPTIONS = {
  provider: { type: 'string' },
  model: { type: 'string' },
  language: { type: 'string' },
  'min-confidence': { type: 'string' },
  format: { type: 'string', default: 'markdown' },
  verify: { type: 'boolean' },
  'no-verify': { type: 'boolean' },
  investigate: { type: 'boolean' },
  'no-investigate': { type: 'boolean' },
  'no-resolve': { type: 'boolean' },
  'no-conversation': { type: 'boolean' },
  skill: { type: 'string', multiple: true },
  'dry-run': { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  debug: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const satisfies ParseArgsOptionsConfig

export function parseSkills(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined || values.length === 0) return undefined
  return values.map((value) => {
    const name = value.trim()
    if (!SKILL_NAME.test(name)) {
      throw new UsageError(
        `Invalid --skill "${value}". Use the skill name, or plugin:skill for a skill of a plugin.`,
      )
    }
    return name
  })
}

function parseInitArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseOptions(argv, {
    global: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) return { kind: 'help', text: INIT_USAGE }
  const [name, ...extra] = positionals
  if (name === undefined) return { kind: 'init', global: values.global }
  if (!values.global) {
    throw new UsageError(
      `A repository is only used with --global, e.g. phada init --global ${name}.`,
    )
  }
  if (extra.length > 0) throw new UsageError('Give one repository at a time.')
  return { kind: 'init', global: true, repo: parseRepositoryName(name) }
}

function parseIndexArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseOptions(argv, {
    ref: { type: 'string' },
    format: { type: 'string', default: 'text' },
    debug: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) return { kind: 'help', text: INDEX_USAGE }
  const [name, ...extra] = positionals
  if (name === undefined) {
    throw new UsageError('Missing the repository to index, e.g. phada index owner/repo.')
  }
  if (extra.length > 0) throw new UsageError('Index one repository at a time.')
  const repo = parseRepositoryName(name)
  if (values.format !== 'text' && values.format !== 'json') {
    throw new UsageError(`Invalid --format "${values.format}". Use text or json.`)
  }
  const ref = values.ref?.trim()
  if (ref === '') throw new UsageError('--ref needs a branch, tag or commit.')
  return {
    kind: 'index',
    repo,
    ...(ref === undefined ? {} : { ref }),
    format: values.format,
    debug: values.debug,
  }
}

function parseRulesArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseOptions(argv, {
    format: { type: 'string', default: 'text' },
    debug: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) return { kind: 'help', text: RULES_USAGE }
  const [input, ...extra] = positionals
  if (input === undefined) {
    throw new UsageError('Missing the repository or pull request, e.g. phada rules owner/repo#123.')
  }
  if (extra.length > 0) throw new UsageError('Give one repository or pull request at a time.')
  if (values.format !== 'text' && values.format !== 'json') {
    throw new UsageError(`Invalid --format "${values.format}". Use text or json.`)
  }
  const target: RulesTarget = isPullRequestRef(input)
    ? { kind: 'pull', ref: parsePullRequestRef(input) }
    : { kind: 'repo', repo: parseRepositoryName(input) }
  return { kind: 'rules', target, format: values.format, debug: values.debug }
}

function parsePromptArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseOptions(argv, {
    default: { type: 'boolean', default: false },
    skill: { type: 'string', multiple: true },
    format: { type: 'string', default: 'text' },
    debug: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) return { kind: 'help', text: PROMPT_USAGE }
  const [input, ...extra] = positionals
  if (values.default && input !== undefined) {
    throw new UsageError('Use either a pull request or --default.')
  }
  if (!values.default && input === undefined) {
    throw new UsageError(
      'Missing the pull request, e.g. phada prompt owner/repo#123, or --default.',
    )
  }
  if (extra.length > 0) throw new UsageError('Show one pull request at a time.')
  if (values.format !== 'text' && values.format !== 'json') {
    throw new UsageError(`Invalid --format "${values.format}". Use text or json.`)
  }
  const skills = parseSkills(values.skill)
  if (values.default && skills !== undefined) throw new UsageError('--skill needs a pull request.')
  return {
    kind: 'prompt',
    target:
      input === undefined ? { kind: 'default' } : { kind: 'pull', ref: parsePullRequestRef(input) },
    ...(skills === undefined ? {} : { skills }),
    format: values.format,
    debug: values.debug,
  }
}

function parseWatchArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseOptions(argv, {
    once: { type: 'boolean', default: false },
    backfill: { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
    format: { type: 'string' },
    debug: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) return { kind: 'help', text: WATCH_USAGE }
  if (positionals.length > 0) {
    throw new UsageError('phada watch takes no repository; list them under watch: in your config.')
  }
  if (values.format !== undefined && !values.status) {
    throw new UsageError('--format only works with --status.')
  }
  if (values.status && (values.once || values.backfill)) {
    throw new UsageError('Use --status alone, without --once or --backfill.')
  }
  const format = values.format ?? 'text'
  if (format !== 'text' && format !== 'json') {
    throw new UsageError(`Invalid --format "${format}". Use text or json.`)
  }
  return {
    kind: 'watch',
    once: values.once,
    backfill: values.backfill,
    status: values.status,
    format,
    debug: values.debug,
  }
}

function parseMcpArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseOptions(argv, {
    debug: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) return { kind: 'help', text: MCP_USAGE }
  if (positionals.length > 0) throw new UsageError('phada mcp takes no argument.')
  return { kind: 'mcp', debug: values.debug }
}

function parseEnqueueArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseOptions(argv, {
    publish: { type: 'string', default: 'pr' },
    format: { type: 'string', default: 'text' },
    debug: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) return { kind: 'help', text: ENQUEUE_USAGE }
  const [input, ...extra] = positionals
  if (input === undefined)
    throw new UsageError('Missing the pull request, e.g. phada enqueue owner/repo#123.')
  if (extra.length > 0) throw new UsageError('Enqueue one pull request at a time.')
  const { publish, format } = values
  if (publish !== 'pr' && publish !== 'none') {
    throw new UsageError(`Invalid --publish "${publish}". Use pr or none.`)
  }
  if (format !== 'text' && format !== 'json') {
    throw new UsageError(`Invalid --format "${format}". Use text or json.`)
  }
  return { kind: 'enqueue', ref: parsePullRequestRef(input), publish, format, debug: values.debug }
}

function parseHistoryArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseOptions(argv, {
    since: { type: 'string' },
    limit: { type: 'string' },
    stats: { type: 'boolean', default: false },
    refresh: { type: 'boolean', default: false },
    format: { type: 'string' },
    'older-than': { type: 'string' },
    debug: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) return { kind: 'help', text: HISTORY_USAGE }
  const olderThan = values['older-than']
  if (positionals[0] === 'prune') {
    const extra =
      positionals.length > 1 ||
      values.since !== undefined ||
      values.limit !== undefined ||
      values.stats ||
      values.refresh ||
      values.format !== undefined
    if (extra) throw new UsageError('phada history prune takes only --older-than.')
    if (olderThan === undefined) {
      throw new UsageError('phada history prune needs --older-than, e.g. --older-than 180d.')
    }
    const olderThanMs = ageMs(olderThan)
    if (olderThanMs === undefined) {
      throw new UsageError(`Invalid --older-than "${olderThan}". Use a duration like 180d.`)
    }
    if (olderThanMs < MIN_PRUNE_MS) throw new UsageError('Use --older-than 1d at least.')
    return { kind: 'history-prune', olderThanMs, debug: values.debug }
  }
  if (olderThan !== undefined) {
    throw new UsageError('--older-than only works with phada history prune.')
  }
  if (positionals.length > 1) {
    throw new UsageError('Give one repository or pull request at a time.')
  }
  const [input] = positionals
  const target: RulesTarget | undefined =
    input === undefined
      ? undefined
      : isPullRequestRef(input)
        ? { kind: 'pull', ref: parsePullRequestRef(input) }
        : { kind: 'repo', repo: parseRepositoryName(input) }
  const sinceMs = values.since === undefined ? undefined : ageMs(values.since)
  if (values.since !== undefined && sinceMs === undefined) {
    throw new UsageError(`Invalid --since "${values.since}". Use a duration like 30d, 12h or 90m.`)
  }
  const limit = values.limit === undefined ? DEFAULT_HISTORY_LIMIT : Number(values.limit)
  if (!Number.isSafeInteger(limit) || limit < 1 || !/^\d+$/.test(values.limit ?? '1')) {
    throw new UsageError(`Invalid --limit "${values.limit}". Use a whole number from 1.`)
  }
  const format = values.format ?? 'text'
  if (format !== 'text' && format !== 'json') {
    throw new UsageError(`Invalid --format "${format}". Use text or json.`)
  }
  return {
    kind: 'history',
    ...(target === undefined ? {} : { target }),
    ...(sinceMs === undefined ? {} : { sinceMs }),
    limit,
    stats: values.stats,
    refresh: values.refresh,
    format,
    debug: values.debug,
  }
}

function ageMs(text: string): number | undefined {
  if (!DURATION.test(text)) return undefined
  const ms = durationMs(text)
  return ms <= MAX_AGE_MS ? ms : undefined
}

function parseRepositoryName(name: string): RepositoryName {
  const [, owner = '', repo = ''] = REPOSITORY_NAME.exec(name) ?? []
  if ([owner, repo].some((part) => part === '' || part === '.' || part === '..')) {
    throw new UsageError(`Invalid repository "${name}". Use owner/repo.`)
  }
  return { owner, repo }
}

function parseOptions<T extends ParseArgsOptionsConfig>(argv: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...argv], allowPositionals: true, strict: true, options })
  } catch (error) {
    const message = error instanceof Error ? firstSentence(error.message) : String(error)
    throw new UsageError(`${message}.`, { cause: error })
  }
}

function parseMinConfidence(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const cut = /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!isConfidenceCut(cut)) {
    throw new UsageError(
      `Invalid --min-confidence "${value}". Use a whole number from ${CONFIDENCE_FLOOR} to ${MAX_CONFIDENCE}.`,
    )
  }
  return cut
}

function isOutputFormat(value: string): value is OutputFormat {
  return value === 'markdown' || value === 'json'
}

function firstSentence(message: string): string {
  return message.split('. ')[0]?.replace(/\.$/, '') ?? message
}
