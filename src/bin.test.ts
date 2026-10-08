import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { USAGE } from './cli/args.js'

const execFileAsync = promisify(execFile)
const BIN = ['--import', 'tsx', 'src/bin.ts']

describe('bin', () => {
  it('prints the usage and exits with 0 for --help', async () => {
    const { stdout } = await execFileAsync(process.execPath, [...BIN, '--help'])

    expect(stdout).toBe(`${USAGE}\n`)
  }, 20_000)

  it('prints the version of the package', async () => {
    const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string }

    const { stdout } = await execFileAsync(process.execPath, [...BIN, '--version'])

    expect(stdout).toBe(`${version}\n`)
  }, 20_000)

  it('exits with 2 and a usage error when no pull request is given', async () => {
    const failure = await execFileAsync(process.execPath, [...BIN, 'review']).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toMatchObject({
      code: 2,
      stderr: 'phada: Missing the pull request to review. Run with --help for usage.\n',
    })
  }, 20_000)
})
