import type { MissesReplay, ReplayedMiss } from '../app/replay-misses.js'
import { missJson, missLines } from './format-misses.js'
import { formatCount } from './units.js'

const SCHEMA_VERSION = 1

export function formatMissesReplayText(replay: MissesReplay): string {
  if (replay.misses.length === 0 && replay.left === 0) return 'No open misses to replay.\n'
  const blocks = replay.misses.map((item) => missLines(item.miss, statusOf(item)).join('\n'))
  const { tally, earlier } = replay
  const summary = [
    `${tally.caught} of ${tally.replayed} caught in ${tally.version}.`,
    ...(earlier === undefined
      ? []
      : [`Before: ${earlier.caught} of ${earlier.replayed} caught in ${earlier.version}.`]),
  ]
  const failed = failedCount(replay)
  if (failed > 0) {
    summary.push(
      `${formatCount(failed, 'miss', 'misses')} not replayed: ${failed === 1 ? 'its review' : 'their reviews'} failed.`,
    )
  }
  if (replay.left > 0) {
    summary.push(`Stopped with ${formatCount(replay.left, 'miss', 'misses')} left to replay.`)
  }
  return `${[...blocks, summary.join('\n')].join('\n\n')}\n`
}

export function formatMissesReplayJson(replay: MissesReplay): string {
  const { tally, earlier } = replay
  return `${JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      version: replay.version,
      caught: tally.caught,
      replayed: tally.replayed,
      failed: failedCount(replay),
      left: replay.left,
      earlier: earlier ?? null,
      misses: replay.misses.map((item) => ({
        ...missJson(item.miss),
        outcome: item.outcome,
        runId: item.outcome !== 'failed' && item.runId !== undefined ? item.runId : null,
        error: item.outcome === 'failed' ? item.error : null,
      })),
    },
    null,
    2,
  )}\n`
}

function statusOf(item: ReplayedMiss): string {
  return item.outcome === 'failed' ? 'not replayed' : item.outcome
}

function failedCount(replay: MissesReplay): number {
  return replay.misses.filter(({ outcome }) => outcome === 'failed').length
}
