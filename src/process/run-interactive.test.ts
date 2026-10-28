import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { runInteractive } from './run-interactive.js'

const NODE = process.execPath
const OPTIONS = { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } }

describe('runInteractive', () => {
  it('gives the terminal to the child and returns its exit code', async () => {
    const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = []
    const child = new EventEmitter() as ChildProcess
    const result = runInteractive(
      'claude',
      ['auth', 'login'],
      OPTIONS,
      (command, args, options) => {
        calls.push({ command, args, options })
        return child
      },
    )
    child.emit('close', 0, null)

    expect(await result).toEqual({ kind: 'exited', exitCode: 0 })
    expect(calls).toEqual([
      {
        command: 'claude',
        args: ['auth', 'login'],
        options: expect.objectContaining({ stdio: 'inherit', cwd: OPTIONS.cwd, env: OPTIONS.env }),
      },
    ])
  })

  it('returns the exit code of a real child', async () => {
    expect(await runInteractive(NODE, ['-e', 'process.exit(3)'], OPTIONS)).toEqual({
      kind: 'exited',
      exitCode: 3,
    })
  })

  it('returns a child ended by a signal as the shell does, 128 plus the signal', async () => {
    expect(
      await runInteractive(NODE, ['-e', "process.kill(process.pid, 'SIGINT')"], OPTIONS),
    ).toEqual({ kind: 'exited', exitCode: 130 })
  })

  it('says a command it cannot find was not found', async () => {
    expect(await runInteractive('phada-no-such-command', [], OPTIONS)).toEqual({
      kind: 'not-found',
      command: 'phada-no-such-command',
    })
  })

  it('rejects another failure to start the child', async () => {
    const child = new EventEmitter() as ChildProcess
    const result = runInteractive('claude', [], OPTIONS, () => child)
    child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))

    await expect(result).rejects.toThrow('spawn EACCES')
  })

  it('ends the child when the signal aborts', async () => {
    const stop = new AbortController()
    const result = runInteractive(
      NODE,
      ['-e', 'setInterval(() => {}, 1000)'],
      { ...OPTIONS, signal: stop.signal },
      spawn,
    )
    stop.abort()

    expect(await result).toEqual({ kind: 'exited', exitCode: 143 })
  })
})
