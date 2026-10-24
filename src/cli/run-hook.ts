import type { HookSettings } from '../config/watch-settings.js'
import { CommandTimeoutError } from '../process/errors.js'
import { runCommand } from '../process/run-command.js'
import { errorMessage } from '../app/error-message.js'
import type { ReviewEvent } from './review-event.js'

const SHELL = '/bin/sh'

export async function runHook(
  event: ReviewEvent,
  settings: HookSettings,
  env: NodeJS.ProcessEnv,
  run: typeof runCommand = runCommand,
): Promise<string | undefined> {
  const command = settings.commands[event.event]
  if (command === undefined) return undefined
  const name = `The ${event.event} hook`
  try {
    const result = await run(SHELL, ['-c', command], {
      stdin: `${JSON.stringify(event)}\n`,
      cwd: settings.cwd,
      env,
      timeoutMs: settings.timeoutMs,
      detached: true,
    })
    if (result.exitCode === 0) return undefined
    const first = result.stderr.split('\n').find((line) => line.trim() !== '')
    return `${name} exited with ${result.exitCode}${first === undefined ? '' : `: ${first.trim()}`}`
  } catch (error) {
    if (error instanceof CommandTimeoutError) {
      return `${name} did not finish within ${error.timeoutMs / 1000}s and was stopped.`
    }
    return `${name} could not run: ${errorMessage(error)}`
  }
}
