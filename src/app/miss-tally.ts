import type { MissReplayRecord } from '../store/history-store.js'

export interface VersionTally {
  version: string
  caught: number
  replayed: number
}

export function latestTally(
  replays: readonly MissReplayRecord[],
  skipVersion?: string,
): VersionTally | undefined {
  const kept = replays.filter(({ version }) => version !== skipVersion)
  const latest = kept.reduce<MissReplayRecord | undefined>(
    (newest, replay) =>
      newest === undefined || replay.replayedAt > newest.replayedAt ? replay : newest,
    undefined,
  )
  if (latest === undefined) return undefined
  const ofVersion = kept.filter(({ version }) => version === latest.version)
  return {
    version: latest.version,
    caught: ofVersion.filter(({ outcome }) => outcome === 'caught').length,
    replayed: ofVersion.length,
  }
}
