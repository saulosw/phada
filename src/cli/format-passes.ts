import type { PassPlan } from '../app/review-passes.js'
import type { PassReport } from '../review/types.js'
import { toTerminalText } from './terminal-text.js'
import { formatCount, formatDuration, formatTokens } from './units.js'

export function formatPassesLine(plan: readonly PassPlan[]): string {
  const planned = plan.filter(({ status }) => status === 'planned').map(({ skill }) => skill)
  const skipped = plan
    .filter(({ status }) => status === 'skipped')
    .map(({ skill, reason }) => `${skill}${reason === undefined ? '' : ` — ${reason}`}`)
  const tail = skipped.length === 0 ? '' : ` (skipped: ${skipped.join('; ')})`
  return toTerminalText(`Skills: ${planned.join(', ')}${tail}`)
}

export function formatPassesSection(passes: readonly PassReport[]): string {
  const lines = passes.map(({ skill, origin, status, durationMs, usage, findings, reason }) => {
    const where = origin === 'phada' ? 'built-in' : origin
    const head = `- ${skill} (${where}): `
    if (status !== 'reviewed') return toTerminalText(`${head}${status} — ${reason ?? ''}`)
    const parts = [formatCount(findings, 'finding'), formatDuration(durationMs)]
    if (usage !== undefined) {
      parts.push(
        `${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out tokens`,
      )
    }
    return toTerminalText(`${head}${parts.join(' · ')}`)
  })
  return ['## Skills', '', ...lines, ''].join('\n')
}
