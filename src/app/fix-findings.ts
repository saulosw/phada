import type { BlockedCommand, FixOutput, FixRequest, ReviewProvider } from '../providers/types.js'
import type { LocalGit } from '../repository/local-git.js'
import { parseFixOutcomes } from '../review/fix-outcomes.js'
import type { FixOutcome } from '../review/fix-outcomes.js'
import { buildFixPrompt } from '../review/fix-prompt.js'
import type { FixTarget } from '../review/fix-prompt.js'
import { newNonce } from '../review/nonce.js'
import { applyFileSuggestions } from './apply-file-suggestions.js'
import type { FixItem, LeftItem, WorkingFiles } from './apply-file-suggestions.js'

const FIX_TIMEOUT_MS = 900_000
const FIX_MAX_TURNS = 60

export type FixTree = Pick<LocalGit, 'root' | 'workingTree' | 'changedFiles'>

export interface FixFindingsDeps {
  tree: FixTree
  files: WorkingFiles
  provider: ReviewProvider
}

type FixAnswer =
  | {
      status: 'answered'
      outcomes: FixOutcome[]
      unreported: number[]
      summary: string
      blocked: BlockedCommand[]
    }
  | { status: 'failed'; error: unknown }

export type AiFix = FixAnswer & { provider: string; changedFiles: string[] }

export interface FindingsFix<T> {
  applied: T[]
  changedFiles: string[]
  left: LeftItem<T>[]
  ai?: AiFix
}

export interface LeftAfterAi<T> extends LeftItem<T> {
  outcome?: FixOutcome
}

type FixedByAi<T> = LeftItem<T> & { outcome: FixOutcome }

export async function fixFindings<T extends FixItem & FixTarget>(
  findings: readonly T[],
  deps: FixFindingsDeps,
): Promise<FindingsFix<T>> {
  const { tree, provider } = deps
  const before = await tree.workingTree()
  const { applied, left } = await applyFileSuggestions(findings, deps.files)
  const suggested = await tree.workingTree()
  const fix = provider.fix?.bind(provider)
  if (fix === undefined || left.length === 0) {
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

export function leftAfterAi<T extends { number: number }>(
  fix: Pick<FindingsFix<T>, 'left' | 'ai'>,
): { fixed: FixedByAi<T>[]; left: LeftAfterAi<T>[] } {
  const outcomes = new Map(
    fix.ai?.status === 'answered'
      ? fix.ai.outcomes.map((outcome) => [outcome.number, outcome])
      : [],
  )
  const after = fix.left.map((left): LeftAfterAi<T> => {
    const outcome = outcomes.get(left.item.number)
    return outcome === undefined ? left : { ...left, outcome }
  })
  return {
    fixed: after.filter((entry): entry is FixedByAi<T> => entry.outcome?.status === 'fixed'),
    left: after.filter(({ outcome }) => outcome?.status !== 'fixed'),
  }
}

async function askAiToFix(
  fix: (request: FixRequest) => Promise<FixOutput>,
  targets: readonly FixTarget[],
  cwd: string,
): Promise<FixAnswer> {
  const prompt = buildFixPrompt(targets, newNonce())
  try {
    const output = await fix({
      ...prompt,
      cwd,
      timeoutMs: FIX_TIMEOUT_MS,
      maxTurns: FIX_MAX_TURNS,
    })
    const parsed = parseFixOutcomes(
      output.text,
      targets.map(({ number }) => number),
    )
    return { status: 'answered', ...parsed, blocked: output.blocked }
  } catch (error) {
    return { status: 'failed', error }
  }
}

async function changedBetween(tree: FixTree, from: string, to: string): Promise<string[]> {
  return from === to ? [] : await tree.changedFiles(from, to)
}
