import { toTerminalText } from '../app/terminal-text.js'

export function oneLine(text: string): string {
  return toTerminalText(text.replace(/\s+/g, ' ')).trim()
}

export function fit(text: string, width: number, cut: 'end' | 'start' = 'end'): string {
  if (width <= 0) return ''
  const characters = [...text]
  if (characters.length <= width) return text + ' '.repeat(width - characters.length)
  return cut === 'end'
    ? `${characters.slice(0, width - 1).join('')}…`
    : `…${characters.slice(characters.length - width + 1).join('')}`
}

export function wrapText(text: string, width: number): string[] {
  const size = Math.max(width, 1)
  return toTerminalText(text.replace(/\r\n?/g, '\n').replace(/\t/g, ' '))
    .split('\n')
    .flatMap((paragraph) => wrapParagraph(paragraph.trim(), size))
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
