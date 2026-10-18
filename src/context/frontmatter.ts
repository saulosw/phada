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
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (!FENCE.test(lines[0] ?? '')) return { status: 'none' }
  const end = lines.findIndex((line, index) => index > 0 && FENCE.test(line))
  if (end === -1) return { status: 'invalid' }
  const fields = new Map<string, string[]>()
  let current: string | undefined
  let scalar: string | undefined
  let flow: { key: string; text: string } | undefined
  for (const line of lines.slice(1, end)) {
    if (flow !== undefined) {
      flow.text += ` ${line.trim()}`
      if (!flow.text.includes(']')) continue
      fields.set(flow.key, valuesOf(flow.key, flow.text))
      flow = undefined
      continue
    }
    const entry = KEY_LINE.exec(line)
    if (entry !== null) {
      current = (entry[1] ?? '').toLowerCase()
      const raw = withoutComment((entry[2] ?? '').trim())
      scalar = BLOCK_SCALAR.test(raw) ? current : undefined
      if (raw.startsWith('[') && !raw.includes(']')) flow = { key: current, text: raw }
      fields.set(current, scalar === undefined && flow === undefined ? valuesOf(current, raw) : [])
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
    if (continuation !== null && scalar === current && !WHOLE_VALUE_KEYS.has(current)) {
      values.push(...valuesOf(current, continuation[1] ?? ''))
      fields.set(current, values)
      continue
    }
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
  const quote = value[0]
  if (quote !== '"' && quote !== "'") return value.replace(TRAILING_COMMENT, '')
  const end = value.indexOf(quote, 1)
  if (end === -1) return value
  const rest = value.slice(end + 1)
  return rest.trim() === '' || /^\s+#/.test(rest) ? value.slice(0, end + 1) : value
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
