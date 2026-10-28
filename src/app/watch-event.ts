import type { JobRecord, PauseState } from '../watch/types.js'
import type { ReviewRun } from './review-and-publish.js'
import type { ReviewProgress } from './review-progress.js'
import type { ReviewRequestInput, SubmitResult } from './submit-request.js'
import type { WatchEvents, WatchExit } from './watch-repositories.js'

export type WatchEvent =
  | { kind: 'baseline'; repo: string; count: number }
  | { kind: 'queued'; job: JobRecord }
  | { kind: 'superseded'; job: JobRecord }
  | { kind: 'started'; job: JobRecord }
  | { kind: 'waiting'; job: JobRecord }
  | { kind: 'ciFailing'; job: JobRecord }
  | { kind: 'ciCleared'; job: JobRecord }
  | { kind: 'finished'; job: JobRecord; run: ReviewRun }
  | { kind: 'retry'; job: JobRecord; at: string; error: unknown }
  | { kind: 'paused'; pause: PauseState }
  | { kind: 'failed'; job: JobRecord; error: unknown }
  | { kind: 'indexed'; repo: string; sha: string }
  | { kind: 'indexPartial'; repo: string }
  | { kind: 'feedback'; repo: string; number: number; threads: number }
  | { kind: 'warning'; message: string }
  | { kind: 'limited'; count: number; until: string }
  | {
      kind: 'refused'
      request: ReviewRequestInput
      result: SubmitResult & { status: 'refused' }
    }

export type WatchEventSink = (event: WatchEvent) => void

export type WatchEnd = WatchExit | { reason: 'aborted' }

export interface WatchObserver {
  event: WatchEventSink
  progress(job: JobRecord, event: ReviewProgress): void
}

export interface WatchControl {
  readonly done: Promise<WatchEnd>
  stop(): void
  abort(): void
}

export type WatchStarted =
  { status: 'started'; control: WatchControl } | { status: 'elsewhere'; pid: number }

export function watchEventsTo(sink: WatchEventSink): WatchEvents {
  return {
    cycle: () => undefined,
    baseline: (repo, count) => sink({ kind: 'baseline', repo, count }),
    queued: (job) => sink({ kind: 'queued', job }),
    superseded: (job) => sink({ kind: 'superseded', job }),
    started: (job) => sink({ kind: 'started', job }),
    waiting: (job) => sink({ kind: 'waiting', job }),
    ciFailing: (job) => sink({ kind: 'ciFailing', job }),
    ciCleared: (job) => sink({ kind: 'ciCleared', job }),
    finished: (job, run) => sink({ kind: 'finished', job, run }),
    retry: (job, at, error) => sink({ kind: 'retry', job, at, error }),
    paused: (pause) => sink({ kind: 'paused', pause }),
    failed: (job, error) => sink({ kind: 'failed', job, error }),
    indexed: (repo, sha) => sink({ kind: 'indexed', repo, sha }),
    indexPartial: (repo) => sink({ kind: 'indexPartial', repo }),
    feedback: (repo, number, threads) => sink({ kind: 'feedback', repo, number, threads }),
    warning: (message) => sink({ kind: 'warning', message }),
    limited: (count, until) => sink({ kind: 'limited', count, until }),
    refused: (request, result) => sink({ kind: 'refused', request, result }),
  }
}
