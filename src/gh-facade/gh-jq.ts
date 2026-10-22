import { GhFacadeError } from './types.js'

const STEP = /^(?:\.([A-Za-z_][\w-]*)|\[(\d*)\]|\.)/

const NOT_A_PATH =
  'phada: --jq supports only paths like .files[].path during a review; use --json and read the output.'

type Step = { key: string } | { index: number } | { each: true }

export function applyJq(value: unknown, expression: string): string[] {
  return walk([value], parsePath(expression.trim())).map(render)
}

function parsePath(expression: string): Step[] {
  if (!expression.startsWith('.')) throw new GhFacadeError(NOT_A_PATH)
  if (expression === '.') return []
  const steps: Step[] = []
  let rest = expression
  while (rest !== '') {
    const match = STEP.exec(rest)
    if (match === null || match[0] === '') throw new GhFacadeError(NOT_A_PATH)
    const [whole, key, index] = match
    if (key !== undefined) steps.push({ key })
    else if (index === '') steps.push({ each: true })
    else if (index !== undefined) steps.push({ index: Number(index) })
    else if (whole === '.' && rest.length > 1 && rest[1] !== '[')
      throw new GhFacadeError(NOT_A_PATH)
    rest = rest.slice(whole.length)
  }
  return steps
}

function walk(values: unknown[], steps: Step[]): unknown[] {
  return steps.reduce<unknown[]>(
    (current, step) =>
      current.flatMap((value) => {
        if ('each' in step) return Array.isArray(value) ? value : []
        if ('index' in step) return [Array.isArray(value) ? (value[step.index] ?? null) : null]
        return [isRecord(value) ? (value[step.key] ?? null) : null]
      }),
    values,
  )
}

function render(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
