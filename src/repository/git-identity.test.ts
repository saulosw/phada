import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MissingGitIdentityError, readGitIdentity } from './git-identity.js'

const scratch = mkdtempSync(join(tmpdir(), 'phada-identity-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const ENV = { PATH: process.env.PATH, HOME: join(scratch, 'home') }
let count = 0

function clone(config: Record<string, string> = {}): string {
  count += 1
  const dir = join(scratch, `clone-${count}`)
  execFileSync('git', ['init', '-q', dir])
  for (const [key, value] of Object.entries(config)) {
    execFileSync('git', ['-C', dir, 'config', key, value])
  }
  return dir
}

describe('readGitIdentity', () => {
  it('reads the name and email git commits with in the directory', async () => {
    const dir = clone({ 'user.name': 'Ana Lima', 'user.email': 'ana@example.com' })

    expect(await readGitIdentity({ dir, env: ENV })).toEqual({
      name: 'Ana Lima',
      email: 'ana@example.com',
      signing: [],
    })
  })

  it('carries the signing settings of the directory', async () => {
    const dir = clone({
      'user.name': 'Ana Lima',
      'user.email': 'ana@example.com',
      'commit.gpgSign': 'true',
      'gpg.format': 'ssh',
      'user.signingKey': '/keys/ana.pub',
    })

    expect((await readGitIdentity({ dir, env: ENV })).signing).toEqual([
      ['user.signingkey', '/keys/ana.pub'],
      ['commit.gpgsign', 'true'],
      ['gpg.format', 'ssh'],
    ])
  })

  it.each([
    [{ 'user.email': 'ana@example.com' }, 'user.name', 'it'],
    [{ 'user.name': 'Ana Lima' }, 'user.email', 'it'],
    [{}, 'user.name and user.email', 'them'],
  ])('refuses a directory with only %j', async (config, missing, them) => {
    const dir = clone(config)

    const reading = readGitIdentity({ dir, env: ENV })

    await expect(reading).rejects.toBeInstanceOf(MissingGitIdentityError)
    await expect(reading).rejects.toThrow(
      `phada fix commits as you, and git has no ${missing} here: set ${them} with git config --global.`,
    )
  })

  it('reads the global config outside a clone', async () => {
    const home = join(scratch, 'global-home')
    mkdirSync(home)
    execFileSync('git', ['config', '--global', 'user.name', 'Ana Lima'], {
      env: { ...ENV, HOME: home },
    })
    execFileSync('git', ['config', '--global', 'user.email', 'ana@example.com'], {
      env: { ...ENV, HOME: home },
    })

    const identity = await readGitIdentity({ dir: scratch, env: { ...ENV, HOME: home } })

    expect(identity).toMatchObject({ name: 'Ana Lima', email: 'ana@example.com' })
  })
})
