export type Frontmatter =
  | { status: 'none' }
  | { status: 'invalid' }
  | { status: 'ok'; fields: ReadonlyMap<string, string[]> }

const KEY_LINE = /^([A-Za-z][\w-]*):\s*(.*)$/
const LIST_ITEM = /^\s*-(?:\s+(.*))?$/
const CONTINUATION = /^\s+(\S.*)$/
const FENCE = /^---\s*$/
const BLOCK_SCALAR = /^[>|][+-]?$/
const TRAILING_COMMENT = /\s+#.*$/
const WHOLE_VALUE_KEYS = new Set(['description'])

export function readFrontmatter(text: string): Frontmatter {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (!FENCE.test(lines[0] ?? '')) return { status: 'none' }
  const end = lines.findIndex((line, index) => index > 0 && FENCE.test(line))
  if (end === -1) return { status: 'invalid' }
  const fields = new Map<string, string[]>()
  let current: string | undefined
  for (const line of lines.slice(1, end)) {
    const entry = KEY_LINE.exec(line)
    if (entry !== null) {
      current = (entry[1] ?? '').toLowerCase()
      fields.set(current, valuesOf(current, entry[2] ?? ''))
      continue
    }
    if (current === undefined) continue
    const values = fields.get(current) ?? []
    const item = LIST_ITEM.exec(line)
    if (item !== null && !WHOLE_VALUE_KEYS.has(current)) {
      values.push(...valuesOf(current, item[1] ?? ''))
      continue
    }
    const continuation = CONTINUATION.exec(line)
    if (continuation !== null && WHOLE_VALUE_KEYS.has(current)) {
      const joined = [...values, (continuation[1] ?? '').trim()].join(' ')
      fields.set(current, [joined])
    }
  }
  return { status: 'ok', fields }
}

function valuesOf(key: string, raw: string): string[] {
  const value = withoutComment(raw.trim())
  if (WHOLE_VALUE_KEYS.has(key)) {
    const unquoted = unquote(value)
    return unquoted === '' || BLOCK_SCALAR.test(unquoted) ? [] : [unquoted]
  }
  const inner =
    value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : wholeQuoted(value)
  return splitOutsideQuotes(inner)
    .map((part) => unquote(part.trim()))
    .filter((part) => part !== '')
}

function withoutComment(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) return value
  return value.replace(TRAILING_COMMENT, '')
}

function splitOutsideQuotes(text: string): string[] {
  const parts: string[] = []
  let quote: string | undefined
  let braces = 0
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '{') {
      braces += 1
    } else if (char === '}') {
      braces = Math.max(0, braces - 1)
    } else if (char === ',' && braces === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

function wholeQuoted(text: string): string {
  const first = text[0]
  const quoted = (first === '"' || first === "'") && text.indexOf(first, 1) === text.length - 1
  return quoted ? text.slice(1, -1) : text
}

function unquote(text: string): string {
  const first = text[0]
  if (text.length >= 2 && (first === '"' || first === "'") && text.endsWith(first)) {
    return text.slice(1, -1).trim()
  }
  return text
}
