import { matcher } from '../context/ignore.js'
import type { CheckAnnotation, CheckRun } from '../github/check-runs.js'
import type { CommitStatus } from '../github/commit-statuses.js'
import type { JobLog } from '../github/job-log.js'
import { buildCi, CI_MAX_ANNOTATIONS, ciLogsLeft, keepsAnnotation } from '../context/ci.js'
import { ciEntries } from '../context/ci-state.js'
import type { Ci, CiEntry } from '../context/types.js'
import { errorMessage } from './error-message.js'

export interface CiReaders {
  checkRuns(sha: string): Promise<CheckRun[]>
  statuses(sha: string): Promise<CommitStatus[]>
  annotations(checkRunId: number): Promise<CheckAnnotation[]>
  jobLog(jobId: number): Promise<JobLog>
  permissionDenied(error: unknown): boolean
  logUnavailable(error: unknown): boolean
}

export type Warn = (message: string) => void

export class CiReadError extends Error {
  override readonly name = 'CiReadError'

  constructor(readonly warnings: readonly string[]) {
    super(warnings.join('; '))
  }
}

export function countsCheck(patterns: readonly string[] | undefined): (name: string) => boolean {
  if (patterns === undefined || patterns.length === 0) return () => true
  const exact = new Set(patterns)
  const isMatch = matcher(patterns)
  return (name) => exact.has(name) || isMatch(name)
}

export async function readCheckEntries(
  readers: CiReaders,
  sha: string,
  patterns: readonly string[] | undefined,
  warn: Warn,
): Promise<CiEntry[]> {
  const [runs, statuses] = await Promise.all([
    readers.checkRuns(sha).catch((error: unknown) => {
      warn(`CI check runs were not read: ${errorMessage(error)}`)
      return []
    }),
    readers.statuses(sha).catch((error: unknown) => {
      warn(`Commit statuses were not read: ${errorMessage(error)}`)
      return []
    }),
  ])
  return ciEntries(runs, statuses, countsCheck(patterns))
}

export async function readCi(
  readers: CiReaders,
  sha: string,
  patterns: readonly string[] | undefined,
  warn: Warn,
): Promise<Ci> {
  const warnings: string[] = []
  const kept: Warn = (message) => {
    warnings.push(message)
    warn(message)
  }
  const entries = await readCheckEntries(readers, sha, patterns, kept)
  const failing = entries.filter(
    (entry): entry is CiEntry & { id: number } =>
      entry.state === 'failing' && entry.id !== undefined,
  )
  const ci = buildCi(entries, {
    annotations: await readAnnotations(readers, failing, kept),
    logs: await readLogs(readers, entries, failing, kept),
  })
  return warnings.length === 0 ? ci : { ...ci, warnings }
}

async function readAnnotations(
  readers: CiReaders,
  failing: readonly (CiEntry & { id: number })[],
  warn: Warn,
): Promise<Map<number, CheckAnnotation[]>> {
  const annotations = new Map<number, CheckAnnotation[]>()
  let kept = 0
  for (const { id, name } of failing) {
    if (kept >= CI_MAX_ANNOTATIONS) break
    try {
      const read = await readers.annotations(id)
      annotations.set(id, read)
      kept += read.filter(keepsAnnotation).length
    } catch (error) {
      if (readers.permissionDenied(error)) {
        warn(`Check annotations were not read: ${errorMessage(error)}`)
        break
      }
      warn(`The annotations of ${name} were not read: ${errorMessage(error)}`)
    }
  }
  return annotations
}

async function readLogs(
  readers: CiReaders,
  entries: readonly CiEntry[],
  failing: readonly (CiEntry & { id: number })[],
  warn: Warn,
): Promise<Map<number, JobLog>> {
  const logs = new Map<number, JobLog>()
  const unavailable: string[] = []
  for (const { id, name } of failing.filter(({ actions }) => actions)) {
    if (ciLogsLeft(entries, logs) === 0) break
    try {
      logs.set(id, await readers.jobLog(id))
    } catch (error) {
      if (readers.permissionDenied(error)) {
        warn(`Job logs were not read: ${errorMessage(error)}`)
        break
      }
      if (readers.logUnavailable(error)) unavailable.push(name)
      else warn(`The log of ${name} was not read: ${errorMessage(error)}`)
    }
  }
  if (unavailable.length > 0) warn(unavailableLogs(unavailable))
  return logs
}

function unavailableLogs(names: readonly string[]): string {
  const last = names[names.length - 1]
  if (names.length === 1) {
    return `The log of ${last} was not read: it is not available (expired, deleted or never written)`
  }
  return `The logs of ${names.slice(0, -1).join(', ')} and ${last} were not read: they are not available (expired, deleted or never written)`
}
