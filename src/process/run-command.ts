import { AsyncLocalStorage } from 'node:async_hooks'
import { execa } from 'execa'
import {
  CommandAbortedError,
  CommandError,
  CommandNotFoundError,
  CommandOutputTooLargeError,
  CommandTimeoutError,
} from './errors.js'

const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_MAX_OUTPUT_LENGTH = 10_000_000
const KILL_GRACE_MS = 2_000

const detachedChildren = new Set<number>()
const scopes = new AsyncLocalStorage<Set<number>>()

export interface ChildScope {
  run<T>(work: () => T): T
  kill(): void
}

export function killDetachedChildren(): void {
  for (const pid of detachedChildren) signalGroup(pid, 'SIGTERM')
  detachedChildren.clear()
}

export function childScope(): ChildScope {
  const children = new Set<number>()
  return {
    run: (work) => scopes.run(children, work),
    kill: () => {
      for (const pid of children) {
        signalGroup(pid, 'SIGTERM')
        detachedChildren.delete(pid)
      }
      children.clear()
    },
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    return
  }
}

export function trackDetachedChild(pid: number): () => void {
  const scope = scopes.getStore()
  detachedChildren.add(pid)
  scope?.add(pid)
  return () => {
    detachedChildren.delete(pid)
    scope?.delete(pid)
  }
}

export interface RunCommandOptions {
  stdin?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputLength?: number
  detached?: boolean
  signal?: AbortSignal
}

export interface RunCommandResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

export interface RunCommandBytesResult {
  stdout: Uint8Array
  stderr: string
  exitCode: number
  durationMs: number
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const result = await execute(command, args, options, 'utf8')
  return { ...result, stdout: String(result.stdout), stderr: String(result.stderr) }
}

export async function runCommandBytes(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<RunCommandBytesResult> {
  const result = await execute(command, args, options, 'buffer')
  const stderr = result.stderr instanceof Uint8Array ? result.stderr : new Uint8Array()
  return {
    ...result,
    stdout: result.stdout instanceof Uint8Array ? result.stdout : new Uint8Array(),
    stderr: Buffer.from(stderr).toString('utf8'),
  }
}

async function execute(
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
  encoding: 'utf8' | 'buffer',
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputLength = options.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH
  const startedAt = performance.now()
  const child = execa(command, args, {
    input: options.stdin ?? '',
    cwd: options.cwd,
    env: options.env ?? {},
    extendEnv: false,
    timeout: timeoutMs,
    maxBuffer: maxOutputLength,
    reject: false,
    stripFinalNewline: false,
    encoding,
    detached: options.detached ?? false,
    ...(options.signal === undefined ? {} : { cancelSignal: options.signal }),
  })
  const pid = options.detached === true ? child.pid : undefined
  const untrack = pid === undefined ? undefined : trackDetachedChild(pid)
  let groupTimedOut = false
  let graceTimer: NodeJS.Timeout | undefined
  const stopGroup = () => {
    if (pid === undefined || graceTimer !== undefined) return
    signalGroup(pid, 'SIGTERM')
    graceTimer = setTimeout(() => signalGroup(pid, 'SIGKILL'), KILL_GRACE_MS)
  }
  const groupTimer =
    pid === undefined
      ? undefined
      : setTimeout(() => {
          groupTimedOut = true
          stopGroup()
        }, timeoutMs)
  options.signal?.addEventListener('abort', stopGroup, { once: true })
  const result = await child.finally(() => {
    clearTimeout(groupTimer)
    clearTimeout(graceTimer)
    options.signal?.removeEventListener('abort', stopGroup)
    untrack?.()
  })
  const durationMs = performance.now() - startedAt

  if (result.code === 'ENOENT') throw new CommandNotFoundError(command)
  if (result.isCanceled) {
    throw new CommandAbortedError(command)
  }
  if (result.timedOut || groupTimedOut) throw new CommandTimeoutError(command, timeoutMs)
  if (result.isMaxBuffer) throw new CommandOutputTooLargeError(command, maxOutputLength)
  if (result.exitCode === undefined) {
    const cause = result.signal ?? result.code ?? 'an unknown reason'
    throw new CommandError(command, `Command "${command}" ended without an exit code (${cause}).`)
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, durationMs }
}
