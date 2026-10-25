import type { CheckAnnotation } from '../github/check-runs.js'
import type { JobLog } from '../github/job-log.js'
import type { CiCheck } from '../review/types.js'
import { CI_LOG_JOB_BYTES, failedStepLog } from './ci-log.js'
import { ciSummary } from './ci-state.js'
import type { Ci, CiEntry } from './types.js'

export const CI_LOG_TOTAL_BYTES = 12 * 1024
export const CI_MAX_ANNOTATIONS = 50
export const CI_SUMMARY_BYTES = 2 * 1024
export const CI_ANNOTATION_BYTES = 1024
const CI_LOG_MIN_BYTES = 256
const KEPT_LEVELS: ReadonlySet<string> = new Set(['failure', 'warning'])
const TRUNCATED = '[truncated by Phada:'
const STATE_ORDER = ['failing', 'pending', 'passing'] as const

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface CiDetails {
  annotations: ReadonlyMap<number, readonly CheckAnnotation[]>
  logs: ReadonlyMap<number, JobLog>
}

export function keepsAnnotation(annotation: CheckAnnotation): boolean {
  return KEPT_LEVELS.has(annotation.level)
}

export function ciLogsLeft(entries: readonly CiEntry[], logs: ReadonlyMap<number, JobLog>): number {
  return cutLogs(entries, logs).left
}

export function buildCi(entries: readonly CiEntry[], details: CiDetails): Ci {
  const cuts = { truncated: 0 }
  const logs = cutLogs(entries, details.logs)
  cuts.truncated += logs.truncated
  let annotationsLeft = CI_MAX_ANNOTATIONS
  let omittedAnnotations = 0
  const ordered = STATE_ORDER.flatMap((state) => entries.filter((entry) => entry.state === state))
  const checks = ordered.map((entry): CiCheck => {
    if (entry.state !== 'failing') return { name: entry.name, state: entry.state }
    const kept = (entry.id === undefined ? [] : (details.annotations.get(entry.id) ?? [])).filter(
      keepsAnnotation,
    )
    const shown = kept.slice(0, annotationsLeft)
    annotationsLeft -= shown.length
    omittedAnnotations += kept.length - shown.length
    const log = entry.id === undefined ? undefined : logs.cuts.get(entry.id)
    return {
      name: entry.name,
      state: entry.state,
      ...(entry.conclusion === undefined ? {} : { conclusion: entry.conclusion }),
      ...(entry.title === undefined ? {} : { title: cut(entry.title, CI_SUMMARY_BYTES, cuts) }),
      ...(entry.summary === undefined || entry.summary.trim() === ''
        ? {}
        : { summary: cut(entry.summary, CI_SUMMARY_BYTES, cuts) }),
      ...(shown.length === 0
        ? {}
        : { annotations: shown.map((annotation) => annotationLine(annotation, cuts)) }),
      ...(log === undefined || log === '' ? {} : { log }),
    }
  })
  return {
    entries: [...entries],
    checks,
    summary: ciSummary(entries),
    report: {
      annotations: CI_MAX_ANNOTATIONS - annotationsLeft,
      omittedAnnotations,
      logs: logs.cuts.size,
      omittedLogs: logs.omitted,
      truncated: cuts.truncated,
      bytes: byteLength(checks.map((check) => JSON.stringify(check)).join('\n')),
    },
  }
}

interface LogCuts {
  cuts: Map<number, string>
  left: number
  omitted: number
  truncated: number
}

function cutLogs(entries: readonly CiEntry[], logs: ReadonlyMap<number, JobLog>): LogCuts {
  const result: LogCuts = { cuts: new Map(), left: CI_LOG_TOTAL_BYTES, omitted: 0, truncated: 0 }
  for (const { id, state, actions } of entries) {
    const log = id === undefined || state !== 'failing' || !actions ? undefined : logs.get(id)
    if (id === undefined || log === undefined) continue
    if (result.left < CI_LOG_MIN_BYTES) {
      result.omitted++
      continue
    }
    const text = failedStepLog(log.text, Math.min(CI_LOG_JOB_BYTES, result.left), {
      partial: log.partial,
    })
    if (text.startsWith(TRUNCATED)) result.truncated++
    result.cuts.set(id, text)
    result.left -= byteLength(text)
  }
  if (result.left < CI_LOG_MIN_BYTES) result.left = 0
  return result
}

function annotationLine(annotation: CheckAnnotation, cuts: { truncated: number }): string {
  const title =
    annotation.title === null || annotation.title === annotation.message
      ? ''
      : `${annotation.title}: `
  return `${annotation.path}:${annotation.line} ${annotation.level}: ${title}${cut(annotation.message, CI_ANNOTATION_BYTES, cuts)}`
}

function cut(text: string, maxBytes: number, cuts: { truncated: number }): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  cuts.truncated++
  const kept = decoder.decode(bytes.slice(0, maxBytes)).replace(/�$/, '')
  return `${kept}\n[truncated by Phada: ${byteLength(kept)} of ${bytes.length} bytes]`
}

function byteLength(text: string): number {
  return encoder.encode(text).length
}
