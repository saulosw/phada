const PREVIEW_LENGTH = 500

export function jsonObjects(text: string): unknown[] {
  const objects: unknown[] = []
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = matchingBrace(text, start)
    if (end === undefined) continue
    try {
      objects.push(JSON.parse(text.slice(start, end + 1)) as unknown)
      start = end
    } catch {
      continue
    }
  }
  return objects
}

export function preview(text: string): string {
  return text.trim().slice(0, PREVIEW_LENGTH)
}

function matchingBrace(text: string, start: number): number | undefined {
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (char === '\\') index++
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) return index
    }
  }
  return undefined
}
