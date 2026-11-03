import type { ParsedReport } from './parse-report.js'
import type { Claim, ClaimVerdict } from './types.js'

const STRENGTH: Record<ClaimVerdict, number> = { unverified: 0, confirmed: 1, contradicted: 2 }

const MIN_PREFIX_WORDS = 3

interface PassClaims {
  claims: readonly Claim[]
  onlySettled: boolean
}

interface MergedClaim {
  claim: Claim
  pass: number
  texts: string[]
}

export function mergeClaims(passes: readonly PassClaims[]): Claim[] {
  const merged: MergedClaim[] = []
  let earlierPassListedClaims = false
  for (const [pass, { claims, onlySettled }] of passes.entries()) {
    for (const claim of claims) {
      if (earlierPassListedClaims && claim.verdict === 'unverified') continue
      const kept = merged.find((entry) =>
        entry.texts.some((text) =>
          entry.pass === pass ? sameText(text, claim.claim) : sameClaim(text, claim.claim),
        ),
      )
      if (kept === undefined) {
        merged.push({ claim, pass, texts: [claim.claim] })
        continue
      }
      kept.texts.push(claim.claim)
      if (STRENGTH[claim.verdict] > STRENGTH[kept.claim.verdict]) kept.claim = claim
    }
    earlierPassListedClaims ||= !onlySettled && claims.length > 0
  }
  return merged.map(({ claim }) => claim)
}

function sameText(a: string, b: string): boolean {
  const spaced = (text: string) => text.toLowerCase().replace(/\s+/g, ' ')
  return spaced(a) === spaced(b)
}

function sameClaim(a: string, b: string): boolean {
  if (sameText(a, b)) return true
  const [x, y] = [normalized(a), normalized(b)]
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x]
  if (shorter === '') return false
  if (shorter === longer) return true
  return shorter.split(' ').length >= MIN_PREFIX_WORDS && longer.startsWith(`${shorter} `)
}

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function withSettledClaims(report: ParsedReport): ParsedReport {
  if (report.claims === undefined) return report
  return { ...report, claims: report.claims.filter(({ verdict }) => verdict !== 'unverified') }
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
