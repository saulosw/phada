import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli, snippet, withTempDir } from './cli-run.js'
import type { RunCliOptions } from './cli-run.js'
import { ProviderError } from './types.js'

const FAKE_SECRET = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const PRINT_ENV = 'process.stdout.write(JSON.stringify(process.env))'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'phada-cli-run-test-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function options(overrides: Partial<RunCliOptions> = {}): RunCliOptions {
  return {
    providerId: 'fake-cli',
    names: { product: 'Fake CLI', short: 'Fake' },
    command: process.execPath,
    args: ['-e', PRINT_ENV],
    stdin: '',
    cwd: workDir,
    env: { PATH: process.env.PATH },
    timeoutMs: 10_000,
    ...overrides,
  }
}

async function runCliError(overrides: Partial<RunCliOptions>): Promise<ProviderError> {
  const error = await runCli(options(overrides)).then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof ProviderError)) {
    throw new Error('expected runCli() to reject with ProviderError')
  }
  return error
}

describe('runCli', () => {
  it('returns the output, the exit code and the duration of the command', async () => {
    const result = await runCli(
      options({ args: ['-e', 'process.stdin.pipe(process.stdout)'], stdin: 'hello' }),
    )

    expect(result).toEqual({
      stdout: 'hello',
      stderr: '',
      exitCode: 0,
      durationMs: expect.any(Number),
    })
  })

  it('returns a non-zero exit code instead of throwing', async () => {
    const result = await runCli(options({ args: ['-e', 'process.exitCode = 3'] }))

    expect(result.exitCode).toBe(3)
  })

  it('removes GITHUB_TOKEN and GH_TOKEN and keeps the rest of the env', async () => {
    const result = await runCli(
      options({
        env: {
          PATH: process.env.PATH,
          KEEP: 'yes',
          GITHUB_TOKEN: FAKE_SECRET,
          GH_TOKEN: FAKE_SECRET,
        },
      }),
    )

    const childEnv = JSON.parse(result.stdout) as Record<string, string>
    expect(childEnv.KEEP).toBe('yes')
    expect(childEnv).not.toHaveProperty('GITHUB_TOKEN')
    expect(childEnv).not.toHaveProperty('GH_TOKEN')
  })

  it('runs the command in the given cwd', async () => {
    const result = await runCli(options({ args: ['-e', 'process.stdout.write(process.cwd())'] }))

    expect(result.stdout).toBe(workDir)
  })

  it('reports not-installed with the product name when the command does not exist', async () => {
    const error = await runCliError({ command: join(workDir, 'no-such-cli') })

    expect(error).toMatchObject({ providerId: 'fake-cli', reason: 'not-installed' })
    expect(error.message).toBe(
      `Fake CLI was not found (command "${join(workDir, 'no-such-cli')}").`,
    )
    expect(error.cause).toBeInstanceOf(Error)
  })

  it('reports timeout with the short name when the command never answers', async () => {
    const error = await runCliError({ args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 300 })

    expect(error).toMatchObject({ providerId: 'fake-cli', reason: 'timeout' })
    expect(error.message).toBe('Fake did not answer within 0.3s.')
  })

  it('reports failed when the command is killed by a signal', async () => {
    const error = await runCliError({ args: ['-e', "process.kill(process.pid, 'SIGKILL')"] })

    expect(error.reason).toBe('failed')
    expect(error.message).toContain('SIGKILL')
  })
})

describe('withTempDir', () => {
  it('creates an empty dir with the prefix and removes it afterwards', async () => {
    let seen = ''

    const result = await withTempDir('phada-test-', async (dir) => {
      seen = dir
      expect(existsSync(dir)).toBe(true)
      expect(basename(dir)).toMatch(/^phada-test-/)
      return 'done'
    })

    expect(result).toBe('done')
    expect(existsSync(seen)).toBe(false)
  })

  it('removes the dir when the callback throws', async () => {
    let seen = ''

    await expect(
      withTempDir('phada-test-', async (dir) => {
        seen = dir
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(seen)).toBe(false)
  })
})

describe('snippet', () => {
  it('redacts tokens, trims and truncates', () => {
    expect(snippet(`  token ${FAKE_SECRET} here  `, 100)).toBe('token [REDACTED] here')
    expect(snippet('abcdef', 3)).toBe('abc')
  })

  it('redacts before truncating, so a token cut at the limit never leaks', () => {
    expect(snippet(`${'x'.repeat(10)} ${FAKE_SECRET}`, 20)).not.toContain('ghp_')
  })
})
