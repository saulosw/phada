import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { constants } from 'node:os'

export type InteractiveResult =
  { kind: 'exited'; exitCode: number } | { kind: 'not-found'; command: string }

export interface InteractiveOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export type SpawnChild = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

const SIGNAL_EXIT_BASE = 128

export function runInteractive(
  command: string,
  args: readonly string[],
  options: InteractiveOptions,
  spawn: SpawnChild = nodeSpawn,
): Promise<InteractiveResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      cwd: options.cwd,
      env: options.env,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') resolve({ kind: 'not-found', command })
      else if (error.name !== 'AbortError') reject(error)
    })
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      resolve({ kind: 'exited', exitCode: code ?? signalExitCode(signal) })
    })
  })
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  return SIGNAL_EXIT_BASE + (signal === null ? 0 : constants.signals[signal])
}
