export interface KeptLayout {
  text: string
  reformatted: boolean
}

type Match = readonly [number, number]

const COMMENTED = /^([^#'"]*\S)(\s+)(#.*)$/
const OPENS: ReadonlySet<string> = new Set(['[', '{'])
const CLOSES: ReadonlySet<string> = new Set([']', '}'])

export function keepLayout(original: string, baseline: string, changed: string): KeptLayout {
  const written = original.split('\n')
  const before = baseline.split('\n')
  const after = changed.split('\n')
  const writtenOf = new Map(
    matchLines(before.map(layoutKey), written.map(layoutKey), (a, b) => a === b),
  )
  const kept = (index: number) => {
    const at = writtenOf.get(index)
    return at === undefined ? before[index] : written[at]
  }
  const unchanged = matchLines(before, after, (a, b) => a === b)
  const lines: string[] = []
  let removedFrom = 0
  let addedFrom = 0
  for (const [stays, staysAs] of [...unchanged, [before.length, after.length] as const]) {
    const removed = Array.from({ length: stays - removedFrom }, (_, offset) =>
      kept(removedFrom + offset),
    )
    const added = after.slice(addedFrom, staysAs)
    lines.push(
      ...added.map((line, offset) =>
        alignComment(
          line,
          removed.length === added.length ? removed[offset] : sameComment(line, removed),
        ),
      ),
    )
    if (stays < before.length) lines.push(kept(stays) ?? '')
    removedFrom = stays + 1
    addedFrom = staysAs + 1
  }
  const lost = written.length - matchLines(written, lines, (a, b) => a === b).length
  return { text: lines.join('\n'), reformatted: lost > before.length - unchanged.length }
}

function layoutKey(line: string): string {
  const indent = /^\s*/.exec(line)?.[0] ?? ''
  let key = ''
  let quote: string | undefined
  let space = false
  for (const char of line.slice(indent.length).trimEnd()) {
    if (quote === undefined && /\s/.test(char)) {
      space = true
      continue
    }
    if (space && !OPENS.has(key.at(-1) ?? '') && !(quote === undefined && CLOSES.has(char))) {
      key += ' '
    }
    space = false
    key += char
    if (quote !== undefined) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") {
      quote = char
    }
  }
  return `${indent}${key}`
}

function sameComment(
  line: string,
  candidates: readonly (string | undefined)[],
): string | undefined {
  const comment = COMMENTED.exec(line)?.[3]
  if (comment === undefined) return undefined
  return candidates.find((candidate) => COMMENTED.exec(candidate ?? '')?.[3] === comment)
}

function alignComment(line: string, original: string | undefined): string {
  const now = COMMENTED.exec(line)
  const was = original === undefined ? null : COMMENTED.exec(original)
  if (now === null || was === null || now[3] !== was[3]) return line
  const [, code = '', , comment = ''] = now
  const [, wasCode = '', gap = ''] = was
  const width = gap.length === 1 ? 1 : Math.max(wasCode.length + gap.length - code.length, 1)
  return `${code}${' '.repeat(width)}${comment}`
}

function matchLines(
  a: readonly string[],
  b: readonly string[],
  same: (x: string, y: string) => boolean,
): Match[] {
  const lengths = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    const row = lengths[i] as number[]
    const below = lengths[i + 1] as number[]
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = same(a[i] as string, b[j] as string)
        ? (below[j + 1] as number) + 1
        : Math.max(below[j] as number, row[j + 1] as number)
    }
  }
  const matches: Match[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (same(a[i] as string, b[j] as string)) {
      matches.push([i, j])
      i++
      j++
    } else if ((lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0)) {
      i++
    } else {
      j++
    }
  }
  return matches
}
