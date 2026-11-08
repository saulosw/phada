import type { RunRecord } from '../store/history-store.js'

export type RunTarget = Pick<
  RunRecord,
  'source' | 'repo' | 'number' | 'headSha' | 'branch' | 'dirty'
>

const SHORT_SHA_LENGTH = 7

export function runTarget(run: RunTarget): string {
  return `${run.repo}${runPlace(run)}`
}

export function runPlace(run: RunTarget): string {
  if (run.source !== 'local') return `#${run.number}`
  return `@${localRunName(run.branch, run.headSha)}${run.dirty === true ? '*' : ''} (local)`
}

export function localRunName(branch: string | undefined, head: string): string {
  return branch ?? head.slice(0, SHORT_SHA_LENGTH)
}
