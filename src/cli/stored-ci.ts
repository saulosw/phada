import { z } from 'zod'
import type { StoredRun } from '../app/stored-run.js'
import type { PullCi } from '../app/watch-repositories.js'
import type { CiState } from '../context/types.js'
import type { CiCheckState } from '../review/types.js'

export interface EventCi {
  state: CiState
  checks: { name: string; state: CiCheckState }[]
}

const EventCiSchema = z.object({
  state: z.enum(['none', 'pending', 'passing', 'failing']),
  checks: z.array(z.object({ name: z.string(), state: z.enum(['passing', 'failing', 'pending']) })),
})

export function ciSkipJson({ summary, checks }: PullCi): string {
  const { state, failing, pending } = summary
  return JSON.stringify({ ci: { state, failing, pending, checks } })
}

export function eventCiOf({ ci, everyCiCheckRead }: StoredRun): EventCi | null {
  if (ci === null || !everyCiCheckRead) return null
  const parsed = EventCiSchema.safeParse(ci)
  if (!parsed.success) return null
  const { state, checks } = parsed.data
  return { state, checks: checks.map(({ name, state }) => ({ name, state })) }
}
