export const WAKE_STEP_MS = 10_000

export interface WakeDeps {
  sleep(ms: number): Promise<void>
  readyJobs(): readonly number[]
  stopped(): boolean
}

export async function sleepUntilNewJob(ms: number, deps: WakeDeps): Promise<void> {
  const known = new Set(deps.readyJobs())
  for (let left = ms; left > 0; left -= WAKE_STEP_MS) {
    await deps.sleep(Math.min(WAKE_STEP_MS, left))
    if (deps.stopped()) return
    if (deps.readyJobs().some((id) => !known.has(id))) return
  }
}
