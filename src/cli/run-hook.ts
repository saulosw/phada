import type { HookSettings } from '../config/watch-settings.js'
import type { ReviewEvent } from './review-event.js'
import { runShell } from './run-shell.js'

export async function runHook(
  event: ReviewEvent,
  settings: HookSettings,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const command = settings.commands[event.event]
  if (command === undefined) return undefined
  const name = `The ${event.event} hook`
  const outcome = await runShell(command, `${JSON.stringify(event)}\n`, {
    cwd: settings.cwd,
    env,
    timeoutMs: settings.timeoutMs,
  })
  switch (outcome.status) {
    case 'ok':
      return undefined
    case 'exited':
      return `${name} exited with ${outcome.exitCode}${outcome.firstLine === undefined ? '' : `: ${outcome.firstLine}`}`
    case 'timeout':
      return `${name} did not finish within ${outcome.timeoutMs / 1000}s and was stopped.`
    case 'error':
      return `${name} could not run: ${outcome.message}`
  }
}
