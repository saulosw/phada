import type { ParsedReport } from './parse-report.js'
import type { Claim, ClaimVerdict } from './types.js'

const STRENGTH: Record<ClaimVerdict, number> = { unverified: 0, confirmed: 1, contradicted: 2 }

export function mergeClaims(lists: readonly (readonly Claim[])[]): Claim[] {
  const merged = new Map<string, Claim>()
  for (const claim of lists.flat()) {
    const key = claim.claim.toLowerCase().replace(/\s+/g, ' ')
    const kept = merged.get(key)
    if (kept === undefined || STRENGTH[claim.verdict] > STRENGTH[kept.verdict]) {
      merged.set(key, claim)
    }
  }
  return [...merged.values()]
}

export function claimWarnings(
  report: Pick<ParsedReport, 'claims' | 'invalidClaims'>,
  skill?: string,
): string[] {
  const missing =
    'the AI answer had no claims list: the claims of the pull request description were not checked.'
  const warnings = [
    ...(report.claims === undefined ? [missing] : []),
    ...(report.invalidClaims > 0
      ? [
          `left out ${String(report.invalidClaims)} ${report.invalidClaims === 1 ? 'claim' : 'claims'} of the AI answer with the wrong shape.`,
        ]
      : []),
  ]
  return warnings.map((warning) =>
    skill === undefined
      ? `${warning.charAt(0).toUpperCase()}${warning.slice(1)}`
      : `Skill ${skill}: ${warning}`,
  )
}
