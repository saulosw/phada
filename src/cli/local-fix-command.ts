import { fixFindings } from '../app/fix-findings.js'
import { readLocalFix } from '../app/local-fix.js'
import type { LocalFixTarget } from '../app/local-fix.js'
import { dataFiles } from '../config/data-paths.js'
import { nodeFileSystem } from '../config/local-files.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { loadTopLevelUserLayers } from '../config/user-config.js'
import { historyEnabled } from '../config/watch-settings.js'
import { openLocalGit } from '../repository/local-git.js'
import type { LocalGit, LocalGitOptions } from '../repository/local-git.js'
import type { ReviewProvider } from '../providers/types.js'
import type { HistoryStore } from '../store/history-store.js'
import type { CliCommand } from './args.js'
import { fixProvider, reportFix, startFix, workingFiles } from './fix-wiring.js'
import { formatFixList, formatHeadMoved } from './format-fix.js'
import { existingHistory } from './history-access.js'
import type { TextOutput } from './progress.js'
import type { ProviderOptions } from './provider-choice.js'

export type FixCommand = Pick<
  Extract<CliCommand, { kind: 'fix' }>,
  'list' | 'only' | 'provider' | 'model'
>

export interface FixCommandDeps {
  cwd: string
  env: NodeJS.ProcessEnv
  home: string
  files: LocalFileSystem
  stdout: TextOutput
  stderr: TextOutput
  openHistoryStore: (path: string) => Promise<HistoryStore>
  createProvider: (name: string, options: ProviderOptions) => ReviewProvider
  openLocalGit?: (options: LocalGitOptions) => Promise<LocalGit>
}

export async function runLocalFix(command: FixCommand, deps: FixCommandDeps): Promise<void> {
  const local = await (deps.openLocalGit ?? openLocalGit)({ dir: deps.cwd, env: deps.env })
  const target = await readTarget(local, deps)
  const started = await startFix(
    command,
    {
      findings: target.findings,
      nothingToFix: `Nothing to fix: run ${target.run} found no findings.`,
      unknownNumber: (number, last) =>
        `No finding ${number} in run ${target.run}: its findings go from 1 to ${last}.`,
      list: formatFixList(target),
      afterPick: () => {
        if (target.head !== target.reviewedHead) {
          deps.stderr.write(`${formatHeadMoved(target)}\n`)
        }
      },
      prepare: async () => fixProvider(await local.origin(), command, deps),
    },
    deps.stdout,
  )
  if (started === undefined) return
  const fixed = await fixFindings(started.picked, {
    tree: local,
    files: workingFiles(local.root, nodeFileSystem),
    provider: started.prepared,
  })
  reportFix(fixed, deps)
}

async function readTarget(local: LocalGit, deps: FixCommandDeps): Promise<LocalFixTarget> {
  const historyOff = !historyEnabled(await loadTopLevelUserLayers(deps))
  const history = await existingHistory(dataFiles(deps.env, deps.home).history, deps)
  try {
    return await readLocalFix(
      { local, lastLocalRun: (repo, branch) => history?.lastLocalRun(repo, branch) },
      { historyOff },
    )
  } finally {
    history?.close()
  }
}
