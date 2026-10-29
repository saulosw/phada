export function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

export function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}
