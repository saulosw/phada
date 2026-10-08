import { toTerminalText } from './terminal-text.js'

const RULE_LINE = /^(\s*)(([-=*_])(?:\s*\3)*\s*)$/
const BLOCK_MARKER = /^((?:\s*(?:>|[-*+]\s|\d{1,9}[.)]\s))*\s*)(#|<|```|~~~)/

export function blockText(text: string): string {
  return toTerminalText(text)
    .trim()
    .split('\n')
    .map((line) => line.replace(RULE_LINE.test(line) ? RULE_LINE : BLOCK_MARKER, '$1\\$2'))
    .join('\n')
}

export function cell(text: string): string {
  return singleLine(text).replace(/(\\*)\|/g, '$1$1\\|')
}

export function singleLine(text: string): string {
  return toTerminalText(text)
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

const INLINE_CODE = /(?<![`\\])(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g
const PARAGRAPH_BREAK = /(\n[ \t]*\n)/
const MENTION = /@(?=[A-Za-z0-9])/g
const REFERENCE = /(?<![\w&])((?:[\w.-]+\/[\w.-]+)?#|gh-)(?=\d)/gi
const FENCE_LINE = /^((?:\s*(?:>|[-*+]\s|\d{1,9}[.)]\s))*\s*)(```|~~~)/

export function githubBlock(text: string): string {
  return blockText(escapeInline(toTerminalText(text)))
}

export function githubLine(text: string): string {
  return escapeInline(singleLine(text))
}

export function githubCell(text: string): string {
  return cell(escapeInline(singleLine(text)))
}

function escapeInline(text: string): string {
  return text
    .split(PARAGRAPH_BREAK)
    .map((part, index) => (index % 2 === 1 ? part : escapeParagraph(part)))
    .join('')
    .replace(MENTION, '@\u200b')
}

function escapeParagraph(paragraph: string): string {
  const leftover = paragraph.replace(INLINE_CODE, '')
  if (leftover.includes('`') || paragraph.split('\n').some((line) => FENCE_LINE.test(line))) {
    return escapeText(paragraph)
  }
  let escaped = ''
  let last = 0
  for (const match of paragraph.matchAll(INLINE_CODE)) {
    escaped += escapeText(paragraph.slice(last, match.index)) + match[0]
    last = match.index + match[0].length
  }
  return escaped + escapeText(paragraph.slice(last))
}

function escapeText(text: string): string {
  return escapeHtml(text).replace(REFERENCE, '$1\u200b')
}

function escapeHtml(text: string): string {
  return text.replace(/(\\*)</g, '$1$1\\<')
}
