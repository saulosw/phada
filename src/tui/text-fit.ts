import { toTerminalText } from '../app/terminal-text.js'

export function oneLine(text: string): string {
  return toTerminalText(text.replace(/\s+/g, ' ')).trim()
}

export function namesText(values: readonly string[], shown: number): string {
  const names = values.slice(0, shown).map(oneLine).join(', ')
  return values.length > shown ? `${names} +${values.length - shown}` : names
}

export function fit(text: string, width: number, cut: 'end' | 'start' = 'end'): string {
  if (width <= 0) return ''
  const characters = [...text]
  if (characters.length <= width) return text + ' '.repeat(width - characters.length)
  return cut === 'end'
    ? `${characters.slice(0, width - 1).join('')}…`
    : `…${characters.slice(characters.length - width + 1).join('')}`
}

export const ERROR_LINES = 4

export function wrapText(text: string, width: number, maxLines = Infinity): string[] {
  const size = Math.max(width, 1)
  const lines = toTerminalText(text.replace(/\r\n?/g, '\n').replace(/\t/g, ' '))
    .split('\n')
    .flatMap((paragraph) => wrapParagraph(paragraph.trim(), size))
  if (lines.length <= maxLines) return lines
  const kept = Math.max(maxLines, 1)
  return [...lines.slice(0, kept - 1), fit(lines.slice(kept - 1).join(' '), size)]
}

export function errorLines(text: string, width: number): string[] {
  return wrapText(oneLine(text), width, ERROR_LINES)
}

function wrapParagraph(paragraph: string, width: number): string[] {
  if (paragraph === '') return ['']
  const lines: string[] = []
  let line = ''
  for (const word of paragraph.split(/ +/)) {
    let rest = [...word]
    if (line !== '' && [...line].length + 1 + rest.length <= width) {
      line = `${line} ${word}`
      continue
    }
    if (line !== '') lines.push(line)
    while (rest.length > width) {
      lines.push(rest.slice(0, width).join(''))
      rest = rest.slice(width)
    }
    line = rest.join('')
  }
  lines.push(line)
  return lines
}

export function shortenHome(path: string, home: string): string {
  if (home === '' || home === '/') return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
