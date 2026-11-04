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
  | { kind: 'app'; debug: boolean }
  | { kind: 'setup'; debug: boolean }
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
  | { kind: 'history-show'; id: number; format: IndexFormat; debug: boolean }
  | {
      kind: 'misses'
      target?: RulesTarget
      all: boolean
      refresh: boolean
      since?: string
      format: IndexFormat
      debug: boolean
    }
  | { kind: 'misses-dismiss'; id: number; debug: boolean }
  | { kind: 'misses-replay'; target?: RulesTarget; format: IndexFormat; debug: boolean }
  | { kind: 'publish'; id: number; force: boolean; format: IndexFormat; debug: boolean }
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
      target: { kind: 'pull'; ref: PullRequestRef; head?: string } | { kind: 'default' }
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
      continuation?: boolean
      investigate?: boolean
      resolveThreads?: boolean
      conversation?: boolean
      ci?: boolean
      waitCi?: boolean
      skills?: string[]
      head?: string
      dryRun: boolean
      force: boolean
      debug: boolean
    }

export const DEFAULT_HISTORY_LIMIT = 50
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i
const MIN_PRUNE_MS = durationMs('1d')
const MAX_AGE_MS = durationMs('36500d')

export const USAGE = `Usage: phada <command> [options]

Reviews GitHub pull requests with the AI provider you choose. Run phada with no
command in a terminal to open the app: what Phada has set up, running and
reviewed.

Commands:
  setup                  Set up Phada step by step in the app
  review <pull request>  Review a pull request and publish the review on it
  publish <id>           Publish a dry run kept in the history, without the AI
  init                   Create config files for Phada
  index <owner/repo>     Build a map of a repository's code on this machine
  rules <owner/repo[#N]> Show the rules and docs a review would read
  prompt <pull request>  Show the prompt a review would send, without the AI
  watch                  Review new pull requests and pushes on its own
  enqueue <pull request> Ask the watch to review a pull request
  mcp                    Let your AI ask for reviews: an MCP server over stdio
  history                Show past reviews and what happened to Phada's comments
  misses                 Show what people pointed out on reviewed pull requests
                         and Phada did not

Options:
  -h, --help             Show this help
  -v, --version          Show the version

Run "phada review --help", "phada rules --help" and so on for the options of each
command.`

export const SETUP_USAGE = `Usage: phada setup

Opens the app on the setup, one step at a time: the GitHub token, the AI
provider, the language, the repositories to watch, their graph and the .phada/
folder of this repository. Every step can be skipped, and nothing is written
before you confirm it. Phada opens it by itself while your config file does not
exist. Needs an interactive terminal.

Options:
  --debug              Show error details
  -h, --help           Show this help

Environment:
  PHADA_CONFIG_HOME    Folder of your own config (default: ~/.config/phada)`

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
  GH_TOKEN             Used when GITHUB_TOKEN is not set; with neither, Phada
                       uses the token of your gh login (gh auth login)`

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
  GH_TOKEN             Used when GITHUB_TOKEN is not set; with neither, Phada
                       uses the token of your gh login (gh auth login)`

export const REVIEW_USAGE = `Usage: phada review <owner/repo#N | pull request URL> [options]

Reviews a GitHub pull request with the AI provider you choose and publishes the
review on it as the owner of the GitHub token: one review with a comment on the
line of each finding. Use --dry-run to only print it.

Options:
  --provider <name>     AI provider: claude, codex or ollama (default: claude)
  --model <name>        Model (required for ollama; otherwise the model set in the
                        provider's own config; for claude, opus when none is set)
  --language <tag>      Review language, e.g. pt-BR or es (default: English)
  --min-confidence <n>  Confidence cut from ${CONFIDENCE_FLOOR} to ${MAX_CONFIDENCE} (default: ${DEFAULT_MIN_CONFIDENCE}); findings
                        below it are listed as worth checking
  --format <name>       Output: markdown or json (default: markdown)
  --no-verify           Skip the second call to the AI that checks every finding
                        (on by default; it adds about half the time and doubles the
                        tokens)
  --verify              Check the findings, even if your config turns it off
  --no-continuation     Skip the extra call to the AI over the files a review with
                        low coverage left out (on by default)
  --continuation        Run that call, even if your config turns it off
  --no-investigate      Review the diff and the context only, without letting the AI
                        read the rest of the repository
  --investigate         Let the AI read the repository, even if your config turns it off
  --no-resolve          Do not recheck Phada's comments from previous commits, nor
                        resolve the ones whose problem was fixed
  --no-conversation     Do not send the comments, reviews and threads of the pull
                        request to the AI
  --no-ci               Do not read the checks of the head: no CI for the AI, no CI
                        line in the review
  --wait-ci             Before reviewing, wait for the pending checks of the head up
                        to ci.wait (default: 15m) since the command started, even
                        when one fails; no check after 2 minutes reviews at once
  --skill <name>        Review with this skill installed for your AI CLI (plugin:skill
                        for a skill of a plugin; phada is the built-in reviewer);
                        repeat it for several passes; replaces review.skills of the config
  --head <sha>          Replay the review at an earlier commit of the pull request:
                        the diff up to it, with the conversation, threads and checks
                        as they were when it became the head; only with --dry-run,
                        and kept in the history as a replay, never published
  --dry-run             Print what would be published and post nothing
  --force               Review again even if Phada already reviewed this commit
  --debug               Show error details
  -h, --help            Show this help

Config:
  Options can also come from .phada/config.yml in the repository and from your
  own config (see "phada init --help"); flags win.

Environment:
  GITHUB_TOKEN          GitHub token that can read the pull request and the
                        repository contents and write reviews
  GH_TOKEN              Used when GITHUB_TOKEN is not set; with neither, Phada
                        uses the token of your gh login (gh auth login)
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
  GH_TOKEN           Used when GITHUB_TOKEN is not set; with neither, Phada
                     uses the token of your gh login (gh auth login)
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
  GH_TOKEN           Used when GITHUB_TOKEN is not set; with neither, Phada
                     uses the token of your gh login (gh auth login)
  PHADA_CONFIG_HOME  Folder of your own config (default: ~/.config/phada)`

export const PROMPT_USAGE = `Usage: phada prompt <owner/repo#N | pull request URL> [options]
       phada prompt --default [options]

Shows the prompt a review would send to the AI, without calling it: for each
review pass (each skill), the instructions with where each part comes from (the
built-in reviewer, review.prompt, a skill, the rules) and the size of the data
blocks (pull request, docs, conversation, CI, diff).

Options:
  --default          Show the built-in prompt, without a pull request or a token
  --skill <name>     Show the passes of these skills instead of review.skills;
                     repeat it for several
  --head <sha>       Show the prompt at an earlier commit of the pull request, as
                     phada review --head would send it
  --format <name>    Output: text or json (default: text)
  --debug            Show error details
  -h, --help         Show this help

Environment:
  GITHUB_TOKEN       GitHub token that can read the pull request and the
                     repository contents
  GH_TOKEN           Used when GITHUB_TOKEN is not set; with neither, Phada
                     uses the token of your gh login (gh auth login)
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
  GH_TOKEN           Used when GITHUB_TOKEN is not set; with neither, Phada
                     uses the token of your gh login (gh auth login)
  PHADA_CONFIG_HOME  Folder of your own config (default: ~/.config/phada)
  PHADA_DATA_HOME    Folder of the history (default: ~/.local/share/phada)
  PHADA_CACHE_HOME   Folder of the mirrors and indexes (default: ~/.cache/phada)`

export const PUBLISH_USAGE = `Usage: phada publish <id> [options]

Publishes on the pull request the review a dry run kept in the history (its id
is in "phada history" and at the end of "phada review --dry-run"), exactly as it
was found: the AI does not run again. The review is planned against the
comments on the pull request now: a finding whose thread is still open is not
posted again, and the comments the dry run found fixed are resolved. Refused
when the pull request moved to another commit since the dry run, or when Phada
already reviewed that commit, unless --force. The publication is kept in the
history as a new run.

Options:
  --force              Publish even if the pull request moved since the dry run
                       (the comments go on the commit it reviewed) or Phada
                       already reviewed that commit
  --format <name>      Output: text or json (default: text)
  --debug              Show error details
  -h, --help           Show this help

Environment:
  GITHUB_TOKEN         GitHub token that can read the pull request and write
                       reviews
  GH_TOKEN             Used when GITHUB_TOKEN is not set; with neither, Phada
                       uses the token of your gh login (gh auth login)
  PHADA_DATA_HOME      Folder of the history (default: ~/.local/share/phada)`

export const HISTORY_USAGE = `Usage: phada history [<owner/repo[#N]>] [options]
       phada history show <id> [--format text|json]
       phada history prune --older-than <age>

Shows the reviews kept in the local history and what happened to the
comments Phada published: fixed, dismissed (resolved without a change),
ignored (left open until the pull request closed) or still open, and which
ones got a negative reaction or a reply. Reads only this machine, unless
--refresh.

show <id> prints one review of the list as the dry run does: what was
posted (or would have been), the context, conversation, CI, impact, related
repositories, skills, investigation, claims and tokens it kept.

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
  GH_TOKEN             Used when GITHUB_TOKEN is not set; with neither, Phada
                       uses the token of your gh login (gh auth login)
  PHADA_DATA_HOME      Folder of the history (default: ~/.local/share/phada)`

export const MISSES_USAGE = `Usage: phada misses [<owner/repo[#N]>] [options]
       phada misses --refresh <owner/repo> --since <YYYY-MM-DD>
       phada misses --replay [<owner/repo[#N]>] [--format <name>]
       phada misses dismiss <id>

Shows the misses kept in the local history: a thread a person (not a bot,
not Phada, not the author of the pull request) opened on a pull request
Phada had reviewed, with no Phada finding within 5 lines of it, that a later
commit made outdated. Misses stay on this machine and are never published.
The watch and phada history --refresh collect them; --refresh collects them
now.

dismiss <id> takes a miss off the list; collecting again keeps it dismissed.

--replay reviews each pull request again, with your AI, as it was at the
commit where the person commented: one review per pull request and commit,
a dry run kept in the history and never published. A miss is caught when the
replay finds something in the same file within 5 lines of it. The results
are kept per Phada version; replaying again with the same version replaces
them.

Options:
  --refresh            Read the pull requests on GitHub first: the ones due,
                       or the pull request named with owner/repo#N
  --since <date>       With --refresh owner/repo, also read the pull requests
                       closed or merged since that day (YYYY-MM-DD, from
                       00:00 UTC), the 50 most recently closed
  --replay             Review the open misses again and say which ones Phada
                       catches now
  --all                Also show the dismissed misses
  --format <name>      Output: text or json (default: text)
  --debug              Show error details
  -h, --help           Show this help

Environment:
  GITHUB_TOKEN         GitHub token for --refresh and --replay
  GH_TOKEN             Used when GITHUB_TOKEN is not set; with neither, Phada
                       uses the token of your gh login (gh auth login)
  PHADA_DATA_HOME      Folder of the history (default: ~/.local/share/phada)`

const REPOSITORY_NAME = /^([\w.-]+)\/([\w.-]+)$/

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [command, ...rest] = argv
  if (command === 'setup') return parseSetupArgs(rest)
  if (command === 'review') return parseReviewArgs(rest)
  if (command === 'publish') return parsePublishArgs(rest)
  if (command === 'init') return parseInitArgs(rest)
  if (command === 'index') return parseIndexArgs(rest)
  if (command === 'rules') return parseRulesArgs(rest)
  if (command === 'prompt') return parsePromptArgs(rest)
  if (command === 'watch') return parseWatchArgs(rest)
  if (command === 'history') return parseHistoryArgs(rest)
  if (command === 'misses') return parseMissesArgs(rest)
  if (command === 'enqueue') return parseEnqueueArgs(rest)
  if (command === 'mcp') return parseMcpArgs(rest)
  if (command !== undefined && !command.startsWith('-')) throw unknownCommand(command)

  const { values, positionals } = parseOptions(argv, {
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
    debug: { type: 'boolean', default: false },
  })
  if (values.help) return { kind: 'help', text: USAGE }
  if (values.version) return { kind: 'version' }
  const [extra] = positionals
  if (extra !== undefined) throw unknownCommand(extra)
  return { kind: 'app', debug: values.debug }
}

function unknownCommand(command: string): UsageError {
  if (isPullRequestRef(command)) {
    return new UsageError(`Unknown command "${command}". Did you mean "phada review ${command}"?`)
  }
  return new UsageError(
    `Unknown command "${command}". Available: setup, review, publish, init, index, rules, prompt, watch, enqueue, mcp, history, misses.`,
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
  if (values.continuation === true && values['no-continuation'] === true) {
    throw new UsageError('Use either --continuation or --no-continuation.')
  }
  const continuation =
    values.continuation === true ? true : values['no-continuation'] === true ? false : undefined
  const investigate =
    values.investigate === true ? true : values['no-investigate'] === true ? false : undefined
  if (values['wait-ci'] === true && values['no-ci'] === true) {
    throw new UsageError(
      '--wait-ci waits for the checks that --no-ci does not read; use one of them.',
    )
  }
  const skills = parseSkills(values.skill)
  const head = parseHead(values.head)
  if (head !== undefined && !values['dry-run']) {
    throw new UsageError('--head only runs with --dry-run: a replay never publishes.')
  }
  if (head !== undefined && values['wait-ci'] === true) {
    throw new UsageError(
      '--wait-ci waits for the checks of the current head; --head replays an earlier commit.',
    )
  }

  return {
    kind: 'review',
    ref: parsePullRequestRef(input),
    ...(values.provider === undefined ? {} : { provider: values.provider }),
    ...(values.model === undefined ? {} : { model: values.model.trim() }),
    ...(values.language === undefined ? {} : { language: values.language }),
    ...(minConfidence === undefined ? {} : { minConfidence }),
    format: values.format,
    ...(verify === undefined ? {} : { verify }),
    ...(continuation === undefined ? {} : { continuation }),
    ...(investigate === undefined ? {} : { investigate }),
    ...(values['no-resolve'] === true ? { resolveThreads: false } : {}),
    ...(values['no-conversation'] === true ? { conversation: false } : {}),
    ...(values['no-ci'] === true ? { ci: false } : {}),
    ...(values['wait-ci'] === true ? { waitCi: true } : {}),
    ...(skills === undefined ? {} : { skills }),
    ...(head === undefined ? {} : { head }),
    dryRun: values['dry-run'],
    force: values.force,
    debug: values.debug,
  }
}

function parseHead(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!COMMIT_SHA.test(value)) {
    throw new UsageError(
      `Invalid --head "${value}". Use a commit SHA of at least 7 hex characters.`,
    )
  }
  return value.toLowerCase()
}

const REVIEW_OPTIONS = {
  provider: { type: 'string' },
  model: { type: 'string' },
  language: { type: 'string' },
  'min-confidence': { type: 'string' },
  format: { type: 'string', default: 'markdown' },
  verify: { type: 'boolean' },
  'no-verify': { type: 'boolean' },
  continuation: { type: 'boolean' },
  'no-continuation': { type: 'boolean' },
  investigate: { type: 'boolean' },
  'no-investigate': { type: 'boolean' },
  'no-resolve': { type: 'boolean' },
  'no-conversation': { type: 'boolean' },
  'no-ci': { type: 'boolean' },
  'wait-ci': { type: 'boolean' },
  skill: { type: 'string', multiple: true },
  head: { type: 'string' },
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
    head: { type: 'string' },
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
  if (values.default && values.head !== undefined) {
    throw new UsageError('--head needs a pull request.')
  }
  const head = parseHead(values.head)
  return {
    kind: 'prompt',
    target:
      input === undefined
        ? { kind: 'default' }
        : {
            kind: 'pull',
            ref: parsePullRequestRef(input),
            ...(head === undefined ? {} : { head }),
          },
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

function parseSetupArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseOptions(argv, {
    debug: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) return { kind: 'help', text: SETUP_USAGE }
  if (positionals.length > 0) throw new UsageError('phada setup takes no argument.')
  return { kind: 'setup', debug: values.debug }
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
  if (positionals[0] === 'show') return parseHistoryShow(positionals.slice(1), values)
  if (positionals.length > 1) {
    throw new UsageError('Give one repository or pull request at a time.')
  }
  const [input] = positionals
  const target = input === undefined ? undefined : targetOf(input)
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

function parseMissesArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseOptions(argv, {
    all: { type: 'boolean', default: false },
    refresh: { type: 'boolean', default: false },
    replay: { type: 'boolean', default: false },
    since: { type: 'string' },
    format: { type: 'string' },
    debug: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) return { kind: 'help', text: MISSES_USAGE }
  if (positionals[0] === 'dismiss') {
    if (
      values.all ||
      values.refresh ||
      values.replay ||
      values.since !== undefined ||
      values.format !== undefined
    ) {
      throw new UsageError('phada misses dismiss takes only a miss id.')
    }
    const id = parseRunId(positionals.slice(1), 'phada misses dismiss', 'miss id')
    return { kind: 'misses-dismiss', id, debug: values.debug }
  }
  if (positionals.length > 1) {
    throw new UsageError('Give one repository or pull request at a time.')
  }
  const format = values.format ?? 'text'
  if (format !== 'text' && format !== 'json') {
    throw new UsageError(`Invalid --format "${format}". Use text or json.`)
  }
  const [input] = positionals
  const target = input === undefined ? undefined : targetOf(input)
  if (values.replay) {
    if (values.all) throw new UsageError('--replay reviews the open misses only; remove --all.')
    if (values.refresh) {
      throw new UsageError(
        '--replay reviews the misses already kept; run phada misses --refresh first.',
      )
    }
    if (values.since !== undefined) {
      throw new UsageError('--replay reviews the misses already kept; remove --since.')
    }
    return {
      kind: 'misses-replay',
      ...(target === undefined ? {} : { target }),
      format,
      debug: values.debug,
    }
  }
  const since =
    values.since === undefined ? undefined : closedSince(values.since, values.refresh, target)
  return {
    kind: 'misses',
    ...(target === undefined ? {} : { target }),
    all: values.all,
    refresh: values.refresh,
    ...(since === undefined ? {} : { since }),
    format,
    debug: values.debug,
  }
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

function closedSince(input: string, refresh: boolean, target: RulesTarget | undefined): string {
  if (!refresh) {
    throw new UsageError('--since says which closed pull requests --refresh reads; add --refresh.')
  }
  if (target?.kind === 'pull') {
    throw new UsageError(
      '--since reads the pull requests closed in a repository; give owner/repo, not owner/repo#N.',
    )
  }
  if (target === undefined) {
    throw new UsageError(
      '--since needs a repository, e.g. phada misses --refresh acme/shop --since 2026-10-01.',
    )
  }
  const start = CALENDAR_DATE.test(input) ? new Date(`${input}T00:00:00.000Z`) : undefined
  if (
    start === undefined ||
    Number.isNaN(start.getTime()) ||
    start.toISOString().slice(0, 10) !== input
  ) {
    throw new UsageError(`Invalid --since "${input}". Use a date as YYYY-MM-DD, e.g. 2026-10-01.`)
  }
  return start.toISOString()
}

function targetOf(input: string): RulesTarget {
  return isPullRequestRef(input)
    ? { kind: 'pull', ref: parsePullRequestRef(input) }
    : { kind: 'repo', repo: parseRepositoryName(input) }
}

function parseHistoryShow(
  positionals: readonly string[],
  values: {
    since?: string
    limit?: string
    stats: boolean
    refresh: boolean
    format?: string
    debug: boolean
  },
): CliCommand {
  if (values.since !== undefined || values.limit !== undefined || values.stats || values.refresh) {
    throw new UsageError('phada history show takes only --format.')
  }
  const id = parseRunId(positionals, 'phada history show')
  const format = values.format ?? 'text'
  if (format !== 'text' && format !== 'json') {
    throw new UsageError(`Invalid --format "${format}". Use text or json.`)
  }
  return { kind: 'history-show', id, format, debug: values.debug }
}

function parsePublishArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseOptions(argv, {
    force: { type: 'boolean', default: false },
    format: { type: 'string' },
    debug: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) return { kind: 'help', text: PUBLISH_USAGE }
  const id = parseRunId(positionals, 'phada publish')
  const format = values.format ?? 'text'
  if (format !== 'text' && format !== 'json') {
    throw new UsageError(`Invalid --format "${format}". Use text or json.`)
  }
  return { kind: 'publish', id, force: values.force, format, debug: values.debug }
}

function parseRunId(positionals: readonly string[], command: string, noun = 'run id'): number {
  const [input] = positionals
  if (input === undefined) {
    throw new UsageError(`${command} needs a ${noun}, e.g. ${command} 12.`)
  }
  if (positionals.length > 1) throw new UsageError(`${command} takes one ${noun}.`)
  const id = Number(input)
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(id) || id < 1) {
    throw new UsageError(`Invalid ${noun} "${input}". Use a whole number from 1.`)
  }
  return id
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
