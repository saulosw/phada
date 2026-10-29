import { toTerminalText } from '../app/terminal-text.js'
import type { TokenUsage } from '../providers/types.js'
import type { UsageReport } from '../review/token-usage.js'
import type { PassUsage } from '../review/types.js'
import { formatTokens } from './units.js'

const NOT_REPORTED = 'not reported'

export function formatUsageLine({ passes, total }: UsageReport): string | undefined {
  if (passes.length === 0) return undefined
  const parts = passes.map((pass) => `${passLabel(pass)} ${tokensText(pass.usage)}`)
  if (passes.length > 1 && total !== undefined) parts.push(`total ${tokensText(total)}`)
  return `Tokens: ${parts.join('; ')}`
}

export function formatUsageSection({ passes, total }: UsageReport): string {
  if (passes.length === 0) return '## Tokens\n\nNo AI call.\n'
  const lines = passes.map((pass) => `- ${passLabel(pass)}: ${tokensText(pass.usage)}`)
  if (total !== undefined) lines.push(`- total: ${tokensText(total)}`)
  return `## Tokens\n\n${lines.join('\n')}\n`
}

function passLabel({ pass, skill }: PassUsage): string {
  return skill === undefined ? pass : toTerminalText(skill)
}

function tokensText(usage: TokenUsage | undefined): string {
  if (usage === undefined) return NOT_REPORTED
  const cached =
    usage.cachedInputTokens === undefined
      ? ''
      : ` (${formatTokens(usage.cachedInputTokens)} cached)`
  return `${formatTokens(usage.inputTokens)} in${cached} · ${formatTokens(usage.outputTokens)} out`
}
