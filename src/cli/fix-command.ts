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
import { fixProvider, pickNumbers, workingFiles } from './fix-wiring.js'
import { formatFixList, formatFixReport, formatFixWarnings, formatHeadMoved } from './format-fix.js'
import { existingHistory } from './history-access.js'
import type { TextOutput } from './progress.js'
import type { ProviderOptions } from './provider-choice.js'

export interface FixCommand {
  list: boolean
  only?: number[]
  provider?: string
  model?: string
}

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
  workingTreeFiles?: LocalFileSystem
}

export async function runFix(command: FixCommand, deps: FixCommandDeps): Promise<void> {
  const local = await (deps.openLocalGit ?? openLocalGit)({ dir: deps.cwd, env: deps.env })
  const target = await readTarget(local, deps)
  if (target.findings.length === 0) {
    deps.stdout.write(`Nothing to fix: run ${target.run} found no findings.\n`)
    return
  }
  const picked = pickNumbers(
    target.findings,
    command.only,
    (number, last) =>
      `No finding ${number} in run ${target.run}: its findings go from 1 to ${last}.`,
  )
  if (target.head !== target.reviewedHead) {
    deps.stderr.write(`${formatHeadMoved(target)}\n`)
  }
  if (command.list) {
    deps.stdout.write(formatFixList(target))
    return
  }
  const provider = await fixProvider(await local.origin(), command, deps)
  deps.stdout.write(formatFixList(target))
  const fixed = await fixFindings(picked, {
    tree: local,
    files: workingFiles(local.root, deps.workingTreeFiles ?? nodeFileSystem),
    provider,
  })
  deps.stdout.write(`\n${formatFixReport(fixed)}`)
  for (const warning of formatFixWarnings(fixed)) deps.stderr.write(`${warning}\n`)
  if (fixed.ai?.status === 'failed') throw fixed.ai.error
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
