import { CONFIDENCE_FLOOR } from './select-findings.js'
import type { DebtMode, Finding } from './types.js'

export function isDebt(finding: Finding): boolean {
  return finding.scope === 'repository'
}

export function withoutDroppedDebt(
  findings: readonly Finding[],
  mode: DebtMode,
): { findings: Finding[]; dropped: number } {
  if (mode !== 'off') return { findings: [...findings], dropped: 0 }
  const kept = findings.filter(
    (finding) => !isDebt(finding) || finding.confidence < CONFIDENCE_FLOOR,
  )
  return { findings: kept, dropped: findings.length - kept.length }
}

export function separateDebt(
  findings: readonly Finding[],
  mode: DebtMode,
): { findings: Finding[]; debt: Finding[] } {
  if (mode !== 'summary') return { findings: [...findings], debt: [] }
  return {
    findings: findings.filter((finding) => !isDebt(finding)),
    debt: findings.filter(isDebt),
  }
}
