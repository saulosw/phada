import type { SymbolKind } from '../repo-map/types.js'

export const SIMILAR_MAX = 5
export const SIMILAR_MIN_SCORE = 0.3

export interface Features {
  kind: SymbolKind
  calls: ReadonlySet<string>
  parameters: number
  nameTokens: ReadonlySet<string>
  ownerKind?: SymbolKind
}

export function scoreSimilar(
  target: Features,
  candidate: Features,
): { score: number; shared: string[] } {
  const shared = [...target.calls].filter((name) => candidate.calls.has(name)).sort()
  const score =
    0.5 * jaccard(target.calls, candidate.calls) +
    0.2 * (target.parameters === candidate.parameters ? 1 : 0) +
    0.2 * jaccard(target.nameTokens, candidate.nameTokens) +
    0.1 * (target.ownerKind === candidate.ownerKind ? 1 : 0)
  return { score: Math.round(score * 100) / 100, shared }
}

export function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_\-$]+/)
      .map((token) => token.toLowerCase())
      .filter((token) => token !== ''),
  )
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let common = 0
  for (const item of a) if (b.has(item)) common += 1
  return common / (a.size + b.size - common)
}
