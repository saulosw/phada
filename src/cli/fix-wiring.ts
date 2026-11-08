import { resolve, sep } from 'node:path'
import type { WorkingFiles } from '../app/apply-file-suggestions.js'
import { reportProgress } from '../app/review-progress.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { resolveProvider } from '../config/merge-config.js'
import { loadUserLayers } from '../config/user-config.js'
import type { ReviewProvider } from '../providers/types.js'
import { UsageError } from './errors.js'
import type { FixCommand, FixCommandDeps } from './fix-command.js'
import { printReviewProgress } from './print-review-progress.js'
import { assertProviderChoice } from './provider-choice.js'

export async function fixProvider(
  { owner, repo }: { owner: string; repo: string },
  command: Pick<FixCommand, 'provider' | 'model'>,
  deps: Pick<FixCommandDeps, 'env' | 'home' | 'files' | 'stderr' | 'createProvider'>,
): Promise<ReviewProvider> {
  const userLayers = await loadUserLayers({ ...deps, owner, repo })
  const choice = resolveProvider(
    {
      ...(command.provider === undefined ? {} : { provider: command.provider }),
      ...(command.model === undefined ? {} : { model: command.model }),
    },
    userLayers,
  )
  const options = choice.model === undefined ? {} : { model: choice.model }
  assertProviderChoice(choice.provider, options)
  return reportProgress(
    deps.createProvider(choice.provider, options),
    'review',
    printReviewProgress(deps.stderr),
  )
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
