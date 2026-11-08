export type FixStatus = 'fixed' | 'skipped'

export interface FixOutcome {
  number: number
  status: FixStatus
  reason: string
}

export interface FixOutcomes {
  outcomes: FixOutcome[]
  unreported: number[]
  summary: string
}

const OUTCOME_LINE = /^[\s>*_`-]*#(\d+)\s+(fixed|skipped)\b[\s*_`]*(?:[:\-–—][\s*_`]*)?(.*)$/i

export function parseFixOutcomes(text: string, numbers: readonly number[]): FixOutcomes {
  const sent = new Set(numbers)
  const found = new Map<number, FixOutcome>()
  const rest: string[] = []
  for (const line of text.split('\n')) {
    const match = OUTCOME_LINE.exec(line)
    const number = Number(match?.[1])
    if (match === null || !sent.has(number)) {
      rest.push(line)
      continue
    }
    if (found.has(number)) continue
    const status = match[2]?.toLowerCase() === 'fixed' ? 'fixed' : 'skipped'
    found.set(number, { number, status, reason: (match[3] ?? '').trim() })
  }
  return {
    outcomes: [...found.values()].sort((a, b) => a.number - b.number),
    unreported: numbers.filter((number) => !found.has(number)),
    summary: rest.join('\n').trim(),
  }
}
