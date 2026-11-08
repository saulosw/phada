import { resolve, sep } from 'node:path'
import type { WorkingFiles } from '../app/apply-file-suggestions.js'
import type { FindingsFix } from '../app/fix-findings.js'
import { reportProgress } from '../app/review-progress.js'
import type { LocalFileSystem } from '../config/local-files.js'
import type { ReviewProvider } from '../providers/types.js'
import { UsageError } from './errors.js'
import { formatFixReport, formatFixWarnings } from './format-fix.js'
import type { ListedFinding } from './format-fix.js'
import type { FixCommand, FixCommandDeps } from './local-fix-command.js'
import { printReviewProgress } from './print-review-progress.js'
import type { TextOutput } from './progress.js'
import { assertProviderChoice, loadProviderChoice, modelOption } from './provider-choice.js'

export async function fixProvider(
  repository: { owner: string; repo: string },
  command: Pick<FixCommand, 'provider' | 'model'>,
  deps: Pick<FixCommandDeps, 'env' | 'home' | 'files' | 'stderr' | 'createProvider'>,
): Promise<ReviewProvider> {
  const { choice } = await loadProviderChoice(repository, command, deps)
  const options = modelOption(choice)
  assertProviderChoice(choice.provider, options)
  return reportProgress(
    deps.createProvider(choice.provider, options),
    'review',
    printReviewProgress(deps.stderr),
  )
}

export interface FixStart<T, P> {
  findings: readonly T[]
  nothingToFix: string
  unknownNumber: (number: number, last: number) => string
  list: string
  afterPick?: () => void
  prepare: () => Promise<P>
}

export async function startFix<T extends { number: number }, P>(
  command: Pick<FixCommand, 'list' | 'only'>,
  start: FixStart<T, P>,
  stdout: TextOutput,
): Promise<{ picked: T[]; prepared: P } | undefined> {
  if (start.findings.length === 0) {
    stdout.write(`${start.nothingToFix}\n`)
    return undefined
  }
  const picked = pickNumbers(start.findings, command.only, start.unknownNumber)
  start.afterPick?.()
  if (command.list) {
    stdout.write(start.list)
    return undefined
  }
  const prepared = await start.prepare()
  stdout.write(start.list)
  return { picked, prepared }
}

export function reportFix(
  fixed: FindingsFix<ListedFinding>,
  output: { stdout: TextOutput; stderr: TextOutput },
): void {
  output.stdout.write(`\n${formatFixReport(fixed)}`)
  for (const warning of formatFixWarnings(fixed)) output.stderr.write(`${warning}\n`)
  if (fixed.ai?.status === 'failed') throw fixed.ai.error
}

export function pickNumbers<T extends { number: number }>(
  items: readonly T[],
  only: readonly number[] | undefined,
  unknownNumber: (number: number, last: number) => string,
): T[] {
  if (only === undefined) return [...items]
  const last = items.length
  const unknown = only.find((number) => number > last)
  if (unknown !== undefined) throw new UsageError(unknownNumber(unknown, last))
  return items.filter(({ number }) => only.includes(number))
}

export function workingFiles(root: string, files: LocalFileSystem): WorkingFiles {
  const inside = (path: string): string | undefined => {
    const full = resolve(root, path)
    return full.startsWith(`${root}${sep}`) ? full : undefined
  }
  return {
    read: async (path) => {
      const full = inside(path)
      return full === undefined ? undefined : ((await files.readText(full)) ?? undefined)
    },
    write: async (path, text) => {
      const full = inside(path)
      if (full !== undefined) await files.writeAtomic(full, text)
    },
  }
}
