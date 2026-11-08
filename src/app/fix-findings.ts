import type { ReviewProvider } from '../providers/types.js'
import type { LocalGit } from '../repository/local-git.js'
import type { FixTarget } from '../review/fix-prompt.js'
import { askAiToFix } from './ai-fix.js'
import type { FixAnswer } from './ai-fix.js'
import { applyFileSuggestions } from './apply-file-suggestions.js'
import type { FixItem, LeftItem, WorkingFiles } from './apply-file-suggestions.js'

export type FixTree = Pick<LocalGit, 'root' | 'workingTree' | 'changedFiles'>

export interface FixFindingsDeps {
  tree: FixTree
  files: WorkingFiles
  provider?: ReviewProvider
}

export type AiFix = FixAnswer & { provider: string; changedFiles: string[] }

export interface FindingsFix<T> {
  applied: T[]
  changedFiles: string[]
  left: LeftItem<T>[]
  ai?: AiFix
}

export async function fixFindings<T extends FixItem & FixTarget>(
  findings: readonly T[],
  deps: FixFindingsDeps,
): Promise<FindingsFix<T>> {
  const { tree, provider } = deps
  const before = await tree.workingTree()
  const { applied, left } = await applyFileSuggestions(findings, deps.files)
  const suggested = await tree.workingTree()
  const fix = provider?.fix?.bind(provider)
  if (provider === undefined || fix === undefined || left.length === 0) {
    return { applied, changedFiles: await changedBetween(tree, before, suggested), left }
  }
  const answer = await askAiToFix(
    fix,
    left.map(({ item }) => item),
    tree.root,
  )
  const after = await tree.workingTree()
  return {
    applied,
    changedFiles: await changedBetween(tree, before, after),
    left,
    ai: {
      ...answer,
      provider: provider.id,
      changedFiles: await changedBetween(tree, suggested, after),
    },
  }
}

async function changedBetween(tree: FixTree, from: string, to: string): Promise<string[]> {
  return from === to ? [] : await tree.changedFiles(from, to)
}
