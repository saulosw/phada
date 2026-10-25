import { applyJq } from './gh-jq.js'
import { GhFacadeError } from './types.js'
import type { GhAnswer, GhCheck, GhCommand, GhPullData } from './types.js'

type Bucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'

const CHECK_FIELDS = [
  'name',
  'state',
  'bucket',
  'link',
  'description',
  'workflow',
  'startedAt',
  'completedAt',
]
const ZERO_TIME = '0001-01-01T00:00:00Z'
const FAILED: ReadonlySet<string> = new Set(['ERROR', 'FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED'])
const SKIPPED: ReadonlySet<string> = new Set(['SKIPPED', 'NEUTRAL'])
const PENDING_EXIT_CODE = 8

export function answerChecks(
  command: Extract<GhCommand, { kind: 'pr-checks' }>,
  data: GhPullData,
): GhAnswer {
  if (command.watch && command.json !== undefined) {
    throw new GhFacadeError('cannot use `--watch` with `--json` flag')
  }
  if (data.checks === undefined) {
    throw new GhFacadeError(
      'phada: Phada did not read the checks of this pull request in this review (ci.read: false or --no-ci).',
    )
  }
  if (data.checks.length === 0) {
    throw new GhFacadeError(`no checks reported on the '${data.headRef}' branch`)
  }
  const checks = data.checks.map(shape)
  if (command.json !== undefined) {
    const fields = command.json
    const unknown = fields.find((field) => !CHECK_FIELDS.includes(field))
    if (unknown !== undefined) {
      throw new GhFacadeError(
        `Unknown JSON field: "${unknown}"\nAvailable fields:\n${CHECK_FIELDS.map((field) => `  ${field}`).join('\n')}`,
      )
    }
    const picked = checks.map((check) =>
      Object.fromEntries(fields.map((field) => [field, check[field as keyof ShapedCheck]])),
    )
    return {
      stdout:
        command.jq === undefined
          ? `${JSON.stringify(picked, null, 2)}\n`
          : applyJq(picked, command.jq)
              .map((line) => `${line}\n`)
              .join(''),
      stderr: '',
      exitCode: 0,
    }
  }
  const rows = [...checks].sort(byBucketThenName).map(row)
  const exitCode = checks.some(({ bucket }) => bucket === 'fail')
    ? 1
    : checks.some(({ bucket }) => bucket === 'pending')
      ? PENDING_EXIT_CODE
      : 0
  return { stdout: rows.map((line) => `${line}\n`).join(''), stderr: '', exitCode }
}

interface ShapedCheck {
  name: string
  state: string
  bucket: Bucket
  link: string
  description: string
  workflow: string
  startedAt: string
  completedAt: string
}

function shape(check: GhCheck): ShapedCheck {
  return {
    name: check.name,
    state: check.state,
    bucket: bucketOf(check.state),
    link: check.link,
    description: check.description,
    workflow: check.workflow,
    startedAt: check.startedAt ?? ZERO_TIME,
    completedAt: check.completedAt ?? ZERO_TIME,
  }
}

function bucketOf(state: string): Bucket {
  if (state === 'SUCCESS') return 'pass'
  if (SKIPPED.has(state)) return 'skipping'
  if (FAILED.has(state)) return 'fail'
  return state === 'CANCELLED' ? 'cancel' : 'pending'
}

function byBucketThenName(a: ShapedCheck, b: ShapedCheck): number {
  const rank = (check: ShapedCheck) =>
    check.bucket === 'fail' ? 0 : check.bucket === 'pending' ? 1 : 2
  return (
    rank(a) - rank(b) || a.name.localeCompare(b.name, 'en') || a.link.localeCompare(b.link, 'en')
  )
}

function row(check: ShapedCheck): string {
  return [
    check.name,
    check.bucket === 'cancel' ? 'fail' : check.bucket,
    elapsed(check.startedAt, check.completedAt),
    check.link,
    check.description,
  ].join('\t')
}

function elapsed(startedAt: string, completedAt: string): string {
  if (startedAt === ZERO_TIME || completedAt === ZERO_TIME) return '0'
  const ms = Date.parse(completedAt) - Date.parse(startedAt)
  return Number.isFinite(ms) && ms > 0 ? goDuration(ms) : '0'
}

function goDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const seconds = `${(ms % 60_000) / 1000}s`
  if (hours > 0) return `${hours}h${minutes}m${seconds}`
  return minutes > 0 ? `${minutes}m${seconds}` : seconds
}
