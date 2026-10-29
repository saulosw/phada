import type { Finding } from '../review/types.js'

const WHY_LENGTH = 200

export function debtItem(
  { severity, file, line, title, why }: Finding,
  escape: (text: string) => string,
): string {
  return `- **${severity}** · ${escape(file)}:${line}: ${escape(title)} — ${escape(shortened(why))}`
}

function shortened(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= WHY_LENGTH) return line
  return `${line.slice(0, WHY_LENGTH - 1).replace(/[\uD800-\uDBFF]$/, '')}…`
}
