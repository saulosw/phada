import type { CheckRun } from '../github/check-runs.js'
import type { CommitStatus } from '../github/commit-statuses.js'
import type { CiCheckState } from '../review/types.js'
import type { CiEntry, CiSummary } from './types.js'

const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
])
const FAILED_STATUSES: ReadonlySet<string> = new Set(['failure', 'error'])
const ACTIONS_APP = 'github-actions'

export function ciEntries(
  runs: readonly CheckRun[],
  statuses: readonly CommitStatus[],
  counts: (name: string) => boolean,
): CiEntry[] {
  return [...latestRuns(runs).map(runEntry), ...statuses.map(statusEntry)].filter(({ name }) =>
    counts(name),
  )
}

function latestRuns(runs: readonly CheckRun[]): CheckRun[] {
  const latest = new Map<string, CheckRun>()
  for (const run of runs) {
    const kept = latest.get(run.name)
    if (kept === undefined || later(run, kept)) latest.set(run.name, run)
  }
  return runs.filter((run) => latest.get(run.name) === run)
}

function later(run: CheckRun, than: CheckRun): boolean {
  const started = run.startedAt ?? ''
  const keptStarted = than.startedAt ?? ''
  return started === keptStarted ? run.id > than.id : started > keptStarted
}

export function ciSummary(entries: readonly CiEntry[]): CiSummary {
  const failing = entries.filter(({ state }) => state === 'failing').map(({ name }) => name)
  const pending = entries.filter(({ state }) => state === 'pending').map(({ name }) => name)
  const state =
    entries.length === 0
      ? 'none'
      : failing.length > 0
        ? 'failing'
        : pending.length > 0
          ? 'pending'
          : 'passing'
  return { state, total: entries.length, failing, pending }
}

function runEntry(run: CheckRun): CiEntry {
  const state: CiCheckState =
    run.status !== 'completed'
      ? 'pending'
      : FAILED_CONCLUSIONS.has(run.conclusion ?? '')
        ? 'failing'
        : 'passing'
  return {
    name: run.name,
    kind: 'check-run',
    id: run.id,
    actions: run.app === ACTIONS_APP,
    state,
    ...(state === 'pending' ? { status: run.status } : {}),
    ...(state === 'pending' || run.conclusion === null ? {} : { conclusion: run.conclusion }),
    ...(run.title === null ? {} : { title: run.title }),
    ...(run.summary === null ? {} : { summary: run.summary }),
    ...(run.url === null ? {} : { url: run.url }),
    ...(run.startedAt === null ? {} : { startedAt: run.startedAt }),
    ...(run.completedAt === null ? {} : { completedAt: run.completedAt }),
  }
}

function statusEntry(status: CommitStatus): CiEntry {
  const state: CiCheckState =
    status.state === 'pending'
      ? 'pending'
      : FAILED_STATUSES.has(status.state)
        ? 'failing'
        : 'passing'
  return {
    name: status.context,
    kind: 'status',
    actions: false,
    state,
    ...(state === 'pending' ? {} : { conclusion: status.state }),
    ...(status.description === null ? {} : { title: status.description }),
    ...(status.url === null ? {} : { url: status.url }),
  }
}
