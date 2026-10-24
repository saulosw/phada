import type { HookSettings } from '../config/watch-settings.js'
import type { ReviewEvent } from './review-event.js'
import { runShell, shellFailure } from './run-shell.js'

export async function runHook(
  event: ReviewEvent,
  settings: HookSettings,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const command = settings.commands[event.event]
  if (command === undefined) return undefined
  const outcome = await runShell(command, `${JSON.stringify(event)}\n`, {
    cwd: settings.cwd,
    env,
    timeoutMs: settings.timeoutMs,
  })
  const failure = shellFailure(outcome)
  return failure === undefined ? undefined : `The ${event.event} hook ${failure}`
}
