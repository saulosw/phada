import type { WatchEvents } from '../app/watch-repositories.js'
import type { WatchEventView } from './format-watch.js'

export function printWatchEvents(print: (event: WatchEventView) => void): WatchEvents {
  return {
    cycle: () => undefined,
    baseline: (repo, count) => print({ kind: 'baseline', repo, count }),
    queued: (job) => print({ kind: 'queued', job }),
    superseded: (job) => print({ kind: 'superseded', job }),
    started: (job) => print({ kind: 'started', job }),
    finished: (job, run) => print({ kind: 'finished', job, run }),
    retry: (job, at, error) => print({ kind: 'retry', job, at, error }),
    paused: (pause) => print({ kind: 'paused', pause }),
    failed: (job, error) => print({ kind: 'failed', job, error }),
    indexed: (repo, sha) => print({ kind: 'indexed', repo, sha }),
    indexPartial: (repo) => print({ kind: 'indexPartial', repo }),
    feedback: (repo, number, threads) => print({ kind: 'feedback', repo, number, threads }),
    warning: (message) => print({ kind: 'warning', message }),
    limited: (count, until) => print({ kind: 'limited', count, until }),
  }
}
