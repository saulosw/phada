import { replayMisses } from '../app/replay-misses.js'
import type { MissesReplay, MissGroup, ReplayMissesDeps } from '../app/replay-misses.js'
import { toTerminalText } from '../app/terminal-text.js'
import { dataFiles } from '../config/data-paths.js'
import { loadTopLevelUserLayers } from '../config/user-config.js'
import { historyEnabled } from '../config/watch-settings.js'
import type { StopSignal } from '../tui/open-app.js'
import type { IndexFormat, RulesTarget } from './args.js'
import { UsageError } from './errors.js'
import { formatMissesReplayJson, formatMissesReplayText } from './format-misses-replay.js'
import { requireGitHubToken } from './github-token.js'
import { existingHistory, filterOf } from './history-access.js'
import type { HistoryCommandDeps } from './history-access.js'
import { formatCount } from './units.js'
import { ABORTED_EXIT_CODE } from './watch-command.js'

export interface MissesReplayCommand {
  target?: RulesTarget
  format: IndexFormat
}

export interface MissesReplayDeps extends HistoryCommandDeps {
  version: string
  onSignal: (handler: (signal?: StopSignal) => void) => void
  abort: (code: number) => void
}

export type MissReplayer = (token: string) => ReplayMissesDeps['replay']

export async function runMissesReplay(
  command: MissesReplayCommand,
  deps: MissesReplayDeps,
  replayer: MissReplayer,
): Promise<number> {
  if (!historyEnabled(await loadTopLevelUserLayers(deps))) {
    throw new UsageError('--replay saves to the history; remove history: false from your config.')
  }
  const token = await requireGitHubToken(deps, 'review the pull requests again')
  const history = await existingHistory(dataFiles(deps.env, deps.home).history, deps)
  const filter = filterOf(command.target)
  const stop = new AbortController()
  deps.onSignal(() => {
    if (stop.signal.aborted) {
      deps.abort(ABORTED_EXIT_CODE)
      return
    }
    deps.stderr.write('Stopping after the current review (Ctrl-C again to abort).\n')
    stop.abort()
  })
  try {
    const replay: MissesReplay =
      history === undefined
        ? nothingReplayed(deps.version)
        : await replayMisses(
            { filter, version: deps.version },
            {
              history,
              replay: replayer(token),
              now: () => deps.clock().toISOString(),
              events: progressLines(deps),
              signal: stop.signal,
            },
          )
    deps.stdout.write(
      command.format === 'json' ? formatMissesReplayJson(replay) : formatMissesReplayText(replay),
    )
    const failed = replay.misses.some(({ outcome }) => outcome === 'failed')
    return failed && replay.tally.replayed === 0 ? 1 : 0
  } finally {
    history?.close()
  }
}

function progressLines(deps: MissesReplayDeps): ReplayMissesDeps['events'] {
  const write = (line: string) => deps.stderr.write(`${line}\n`)
  return {
    started: (groups, misses) => {
      if (groups === 0) return
      write(
        `Replaying ${formatCount(misses, 'open miss', 'open misses')}: ${formatCount(groups, 'review')} with your AI, one per pull request and commit.`,
      )
    },
    replaying: (group) =>
      write(
        `[${group.position}/${group.groups}] Reviewing ${groupName(group)} again for ${formatCount(group.misses, 'miss', 'misses')}…`,
      ),
    failed: (group, error) =>
      write(`Warning: ${groupName(group)} was not replayed: ${toTerminalText(error)}`),
  }
}

function groupName({ repo, number, commitSha }: MissGroup): string {
  return toTerminalText(`${repo}#${number} at ${commitSha.slice(0, 7)}`)
}

function nothingReplayed(version: string): MissesReplay {
  return { version, misses: [], tally: { version, caught: 0, replayed: 0 }, left: 0 }
}
