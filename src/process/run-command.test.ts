import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  CommandError,
  CommandNotFoundError,
  CommandOutputTooLargeError,
  CommandTimeoutError,
} from './errors.js'
import { runCommand, runCommandBytes } from './run-command.js'

const NODE = process.execPath

function node(script: string): [string, string[]] {
  return [NODE, ['-e', script]]
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof Error)) throw new Error('expected the promise to reject with an Error')
  return error
}

describe('runCommand', () => {
  it('writes stdin to the child and returns its output, exit code and duration', async () => {
    const result = await runCommand(...node('process.stdin.pipe(process.stdout)'), {
      stdin: 'héllo\nworld\n',
    })

    expect(result).toEqual({
      stdout: 'héllo\nworld\n',
      stderr: '',
      exitCode: 0,
      durationMs: expect.any(Number),
    })
    expect(result.durationMs).toBeGreaterThan(0)
  })

  it('closes stdin when no input is given, so a child reading until EOF finishes', async () => {
    const result = await runCommand(
      ...node(
        'let n = 0; process.stdin.on("data", d => n += d.length).on("end", () => console.log(n))',
      ),
      { timeoutMs: 5_000 },
    )

    expect(result.stdout).toBe('0\n')
  })

  it('returns a non-zero exit code with stdout and stderr instead of throwing', async () => {
    const result = await runCommand(
      ...node('process.stdout.write("{}"); process.stderr.write("bad"); process.exit(3)'),
    )

    expect(result).toMatchObject({ stdout: '{}', stderr: 'bad', exitCode: 3 })
  })

  it('gives the child exactly the env it receives, without inheriting the parent env', async () => {
    process.env.PHADA_PARENT_ONLY = 'leak'
    try {
      const result = await runCommand(
        ...node('console.log(JSON.stringify([process.env.ONLY, process.env.PHADA_PARENT_ONLY]))'),
        { env: { ONLY: 'x' } },
      )

      expect(JSON.parse(result.stdout)).toEqual(['x', null])
    } finally {
      delete process.env.PHADA_PARENT_ONLY
    }
  })

  it('runs the child in the given cwd', async () => {
    const cwd = realpathSync(tmpdir())

    const result = await runCommand(...node('console.log(process.cwd())'), { cwd })

    expect(result.stdout).toBe(`${cwd}\n`)
  })

  it('passes empty and "=" arguments through as single arguments, without a shell', async () => {
    const result = await runCommand(NODE, [
      '-e',
      'console.log(JSON.stringify(process.argv.slice(1)))',
      '',
      '--setting-sources=',
      '$HOME',
    ])

    expect(JSON.parse(result.stdout)).toEqual(['', '--setting-sources=', '$HOME'])
  })

  it('throws CommandNotFoundError when the command does not exist', async () => {
    const error = await captureError(runCommand('phada-no-such-command', ['--flag']))

    expect(error).toBeInstanceOf(CommandNotFoundError)
    expect(error).toMatchObject({ command: 'phada-no-such-command' })
  })

  it('kills the child and throws CommandTimeoutError when it runs past the timeout', async () => {
    const startedAt = performance.now()

    const error = await captureError(
      runCommand(...node('setInterval(() => {}, 1000)'), { timeoutMs: 200 }),
    )

    expect(error).toBeInstanceOf(CommandTimeoutError)
    expect(error).toMatchObject({ command: NODE, timeoutMs: 200 })
    expect(performance.now() - startedAt).toBeLessThan(2_000)
  })

  it('throws CommandOutputTooLargeError when the output passes the limit', async () => {
    const error = await captureError(
      runCommand(...node('process.stdout.write("x".repeat(2000))'), { maxOutputLength: 100 }),
    )

    expect(error).toBeInstanceOf(CommandOutputTooLargeError)
    expect(error).toMatchObject({ maxOutputLength: 100 })
  })

  it('throws CommandError when the child is killed by a signal', async () => {
    const error = await captureError(runCommand(...node('process.kill(process.pid, "SIGKILL")')))

    expect(error).toBeInstanceOf(CommandError)
    expect(error.message).toContain('SIGKILL')
  })

  it('never puts the arguments or stdin in an error message', async () => {
    const secret = 'phada-secret-argument'
    const failures = [
      () => runCommand('phada-no-such-command', [secret], { stdin: secret }),
      () =>
        runCommand(NODE, ['-e', 'setInterval(() => {}, 1000)', secret], {
          stdin: secret,
          timeoutMs: 200,
        }),
      () =>
        runCommand(NODE, ['-e', 'process.stdout.write("x".repeat(500))', secret], {
          stdin: secret,
          maxOutputLength: 10,
        }),
      () =>
        runCommand(NODE, ['-e', 'process.kill(process.pid, "SIGKILL")', secret], {
          stdin: secret,
        }),
    ]

    for (const failure of failures) {
      const error = await captureError(failure())
      expect(error.message).not.toContain(secret)
      expect(error.cause).toBeUndefined()
    }
  })
})

describe('runCommandBytes', () => {
  it('returns the exact bytes the child writes, with stderr as text', async () => {
    const result = await runCommandBytes(
      ...node(
        'process.stdout.write(Buffer.from([0xc3, 0xa9, 0, 0xff])); process.stderr.write("olá")',
      ),
    )

    expect(result.stdout).toEqual(new Uint8Array([0xc3, 0xa9, 0, 0xff]))
    expect(result.stderr).toBe('olá')
    expect(result.exitCode).toBe(0)
  })

  it('writes stdin to the child', async () => {
    const result = await runCommandBytes(...node('process.stdin.pipe(process.stdout)'), {
      stdin: 'abc\n',
    })

    expect(Buffer.from(result.stdout).toString('utf8')).toBe('abc\n')
  })

  it('throws the same typed errors as runCommand', async () => {
    await expect(runCommandBytes('phada-command-that-does-not-exist', [])).rejects.toBeInstanceOf(
      CommandNotFoundError,
    )
    await expect(
      runCommandBytes(...node('setTimeout(() => {}, 10_000)'), { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(CommandTimeoutError)
    await expect(
      runCommandBytes(...node('process.stdout.write("x".repeat(100))'), { maxOutputLength: 10 }),
    ).rejects.toBeInstanceOf(CommandOutputTooLargeError)
  })
})
