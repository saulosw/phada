export type TomlValue = string | string[]

export function parseTomlTables(text: string): Map<string, Map<string, TomlValue>> {
  const tables = new Map<string, Map<string, TomlValue>>([['', new Map()]])
  let current = tables.get('') ?? new Map<string, TomlValue>()
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = withoutComment(lines[index] ?? '').trim()
    if (line === '') continue
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line)
    if (header?.[1] !== undefined) {
      const name = header[1].replace(/["']/g, '')
      current = tables.get(name) ?? new Map()
      tables.set(name, current)
      continue
    }
    const equals = line.indexOf('=')
    if (equals === -1) continue
    const key = line
      .slice(0, equals)
      .trim()
      .replace(/^["']|["']$/g, '')
    let value = line.slice(equals + 1).trim()
    if (value.startsWith('[')) {
      while (!closes(value) && index + 1 < lines.length) {
        index += 1
        value += ` ${withoutComment(lines[index] ?? '').trim()}`
      }
      if (!closes(value)) break
      current.set(key, strings(value))
      continue
    }
    current.set(key, strings(value)[0] ?? '')
  }
  return tables
}

function withoutComment(line: string): string {
  let quote: string | undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#') return line.slice(0, index)
  }
  return line
}

function closes(value: string): boolean {
  let depth = 0
  let quote: string | undefined
  for (const char of value) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") quote = char
    else if (char === '[') depth += 1
    else if (char === ']') depth -= 1
  }
  return depth === 0 && quote === undefined
}

function strings(value: string): string[] {
  return [...value.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)].map(
    ([, double, single]) => double ?? single ?? '',
  )
}
