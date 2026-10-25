import { z } from 'zod'
import type { PullCi } from '../app/watch-repositories.js'
import type { CiState } from '../context/types.js'
import type { CiCheckState } from '../review/types.js'

export interface EventCi {
  state: CiState
  checks: { name: string; state: CiCheckState }[]
}

const StoredCiSchema = z.object({
  ci: z.object({
    state: z.enum(['none', 'pending', 'passing', 'failing']),
    checks: z.array(
      z.object({ name: z.string(), state: z.enum(['passing', 'failing', 'pending']) }),
    ),
  }),
})

export function ciSkipJson({ summary, checks }: PullCi): string {
  const { state, failing, pending } = summary
  return JSON.stringify({ ci: { state, failing, pending, checks } })
}

export function storedCi(resultJson: string | undefined): EventCi | null {
  if (resultJson === undefined) return null
  let value: unknown
  try {
    value = JSON.parse(resultJson)
  } catch {
    return null
  }
  const parsed = StoredCiSchema.safeParse(value)
  if (!parsed.success) return null
  const { state, checks } = parsed.data.ci
  return { state, checks: checks.map(({ name, state }) => ({ name, state })) }
}
