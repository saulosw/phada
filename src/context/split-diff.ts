export interface DiffSection {
  path: string
  text: string
}

const HEADER = /^diff --git (?:"a\/(.+?)"|a\/(\S+?)) (?:"b\/(.+)"|b\/(.+))$/

export function splitDiff(diff: string): { preamble: string; sections: DiffSection[] } {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index)
  const first = starts[0]
  if (first === undefined) return { preamble: diff, sections: [] }
  const sections = starts.map((start, index) => {
    const text = diff.slice(start, starts[index + 1] ?? diff.length)
    return { path: sectionPath(text), text }
  })
  return { preamble: diff.slice(0, first), sections }
}

function sectionPath(text: string): string {
  const lines = text.split('\n')
  const plus = lines.find((line) => line.startsWith('+++ '))
  const minus = lines.find((line) => line.startsWith('--- '))
  if (plus !== undefined && plus !== '+++ /dev/null') return withoutPrefix(plus.slice(4), 'b/')
  if (minus !== undefined) return withoutPrefix(minus.slice(4), 'a/')
  const renamed = lines.find((line) => line.startsWith('rename to '))
  if (renamed !== undefined) return renamed.slice('rename to '.length)
  const header = HEADER.exec(lines[0] ?? '')
  return header?.[3] ?? header?.[4] ?? ''
}

function withoutPrefix(path: string, prefix: string): string {
  const unquoted = path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path
  return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : unquoted
}
