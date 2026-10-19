import type { WatchEvents } from '../app/watch-repositories.js'
import type { JobRecord } from '../store/history-store.js'
import type { WatchEventView } from './format-watch.js'

export function printWatchEvents(
  print: (event: WatchEventView) => void,
  track: (job: JobRecord | undefined) => void,
): WatchEvents {
  const settle = (event: WatchEventView) => {
    track(undefined)
    print(event)
  }
  return {
    cycle: () => undefined,
    baseline: (repo, count) => print({ kind: 'baseline', repo, count }),
    queued: (job) => print({ kind: 'queued', job }),
    superseded: (job) => print({ kind: 'superseded', job }),
    started: (job) => {
      track(job)
      print({ kind: 'started', job })
    },
    finished: (job, run) => settle({ kind: 'finished', job, run }),
    retry: (job, at, error) => settle({ kind: 'retry', job, at, error }),
    paused: (pause) => settle({ kind: 'paused', pause }),
    failed: (job, error) => settle({ kind: 'failed', job, error }),
    indexed: (repo, sha) => print({ kind: 'indexed', repo, sha }),
    indexPartial: (repo) => print({ kind: 'indexPartial', repo }),
    warning: (message) => print({ kind: 'warning', message }),
    limited: (count, until) => print({ kind: 'limited', count, until }),
  }
}
