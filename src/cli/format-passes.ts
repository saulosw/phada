import type { PassPlan } from '../app/review-passes.js'
import type { BlockedCommand } from '../providers/types.js'
import type { PassReport } from '../review/types.js'
import { toTerminalText } from '../app/terminal-text.js'
import { formatCount, formatDuration, formatTokens } from './units.js'

export function formatPassesLine(plan: readonly PassPlan[]): string {
  const planned = plan
    .filter(({ status }) => status === 'planned')
    .map(({ skill, mode }) => (mode === 'native' ? `${skill} (native)` : skill))
  const skipped = plan
    .filter(({ status }) => status === 'skipped')
    .map(({ skill, reason }) => `${skill}${reason === undefined ? '' : ` — ${reason}`}`)
  const tail = skipped.length === 0 ? '' : ` (skipped: ${skipped.join('; ')})`
  return toTerminalText(`Skills: ${planned.join(', ')}${tail}`)
}

export type BlockedFix = (blocked: BlockedCommand) => string

const OUTPUT_PREVIEW_BYTES = 8192

export function formatSkillRunLines(passes: readonly PassReport[], fixFor: BlockedFix): string[] {
  return passes.flatMap(({ skill, mode, durationMs, captured = 0, blocked = [] }) => {
    if (mode !== 'native') return []
    const head = `Skill ${skill}: ran natively in ${formatDuration(durationMs)}, ${formatCount(captured, 'GitHub write')} captured, ${blocked.length} blocked`
    return [head, ...blocked.map((item) => `  blocked ${item.input} (${fixFor(item)})`)].map(
      toTerminalText,
    )
  })
}

export function formatPassesSection(passes: readonly PassReport[], fixFor?: BlockedFix): string {
  const outputs: string[] = []
  const lines = passes.flatMap((pass) => {
    const { skill, origin, status, durationMs, usage, findings, reason, mode } = pass
    const where = origin === 'phada' ? 'built-in' : origin
    const head = `- ${skill} (${where}): `
    if (status !== 'reviewed') return [toTerminalText(`${head}${status} — ${reason ?? ''}`)]
    const parts = [
      ...(mode === 'native' ? ['native'] : []),
      formatCount(findings, 'finding'),
      formatDuration(durationMs),
    ]
    if (usage !== undefined) {
      parts.push(
        `${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out tokens`,
      )
    }
    if (mode === 'native') parts.push(`${formatCount(pass.captured ?? 0, 'GitHub write')} captured`)
    if (pass.output !== undefined) outputs.push(skillOutputBlock(skill, pass.output))
    return [
      toTerminalText(`${head}${parts.join(' · ')}`),
      ...(pass.blocked ?? []).map((item) => {
        const fix = fixFor?.(item) ?? ''
        return toTerminalText(`  - blocked: ${item.input}${fix === '' ? '' : ` — ${fix}`}`)
      }),
    ]
  })
  return ['## Skills', '', ...lines, '', ...outputs].join('\n')
}

function skillOutputBlock(skill: string, output: string): string {
  const bytes = new TextEncoder().encode(output)
  const shown =
    bytes.length <= OUTPUT_PREVIEW_BYTES
      ? output
      : `${new TextDecoder().decode(bytes.subarray(0, OUTPUT_PREVIEW_BYTES)).replace(/\uFFFD+$/, '')}\n[cut at 8 KB; the JSON output has all of it]`
  return `### Skill output: ${toTerminalText(skill)}\n\n${toTerminalText(shown)}\n`
}
