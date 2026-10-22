import type { PromptView } from '../app/inspect-prompt.js'
import { shortSha } from './review-text.js'
import { toTerminalText } from './terminal-text.js'
import { formatBytes } from './units.js'

export function formatPromptText(view: PromptView): string {
  const { pullRequest } = view
  const lines = [
    pullRequest === null
      ? 'Built-in prompt, without a pull request'
      : `Prompt for ${pullRequest.repo}#${pullRequest.number} at ${shortSha(pullRequest.headSha)} (base ${shortSha(pullRequest.baseSha)})`,
    ...view.notes,
    ...view.warnings.map((warning) => `Warning: ${toTerminalText(warning)}`),
    '',
  ]
  view.passes.forEach((pass, index) => {
    const where = pass.origin === 'phada' ? 'built-in' : pass.origin
    const heading = `## Pass ${index + 1}: ${pass.skill} (${pass.mode === 'native' ? 'native, ' : ''}${where})`
    if (pass.status === 'skipped') {
      lines.push(toTerminalText(`${heading} — skipped: ${pass.reason ?? ''}`), '')
      return
    }
    lines.push(toTerminalText(heading), '')
    if (pass.native !== undefined) {
      const { message, commands, readDirs } = pass.native
      lines.push(
        toTerminalText(`Message: ${message}`),
        toTerminalText(
          `Commands: ${typeof commands === 'string' ? commands : commands.join(', ')}`,
        ),
        toTerminalText(
          `Read folders: ${readDirs.length === 0 ? 'the checkout and the skill folder only' : ['the checkout', 'the skill folder', ...readDirs].join(', ')}`,
        ),
        '',
      )
    }
    for (const part of pass.parts) {
      lines.push(
        toTerminalText(`### ${part.section} — ${part.origin}`),
        '',
        toTerminalText(part.text),
        '',
      )
    }
    if (pass.data.length > 0) {
      const width = Math.max(...pass.data.map(({ name }) => name.length))
      lines.push(
        'Data blocks:',
        ...pass.data.map(({ name, bytes }) => `  ${name.padEnd(width)}  ${formatBytes(bytes)}`),
        '',
      )
    }
  })
  return lines.join('\n')
}

export function formatPromptJson(view: PromptView): string {
  return `${JSON.stringify({ schemaVersion: 1, ...view }, null, 2)}\n`
}
