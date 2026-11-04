import type { Coverage, CoverageGapKind, CoverageLevel } from '../review/types.js'

type LoweringGap = Exclude<CoverageGapKind, 'declared-only'>

const LOWERING_GAPS: readonly LoweringGap[] = ['missing', 'not-compared', 'skipped']

export interface CoverageWords {
  level: Readonly<Record<Exclude<CoverageLevel, 'full'>, string>>
  declared: string
  files(covered: number, total: number): string
  gaps: Readonly<Record<LoweringGap, (count: number) => string>>
}

export function coverageLabel(
  { level, covered, total, gaps, verified }: Coverage,
  words: CoverageWords,
): string {
  if (level === 'full') return ''
  const name = verified ? words.level[level] : `${words.level[level]} (${words.declared})`
  const reasons = LOWERING_GAPS.flatMap((kind) => {
    const count = gaps.filter((gap) => gap.kind === kind).length
    return count === 0 ? [] : [words.gaps[kind](count)]
  })
  const why = reasons.length === 0 ? '' : ` (${reasons.join(', ')})`
  return `${name}: ${words.files(covered, total)}${why}`
}
