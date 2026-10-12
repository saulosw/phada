import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalRepository } from '../../test/support/git-repo.js'
import type { LocalRepository } from '../../test/support/git-repo.js'
import { CheckoutError } from './checkout.js'
import type { Checkout } from './checkout.js'
import { openGitMirror } from './git-mirror.js'

let repository: LocalRepository
let checkout: Checkout
let mirrorParent: string

beforeAll(async () => {
  repository = createLocalRepository(
    {
      'src/a.ts': 'export const a = 1\nexport const needle = 2\n',
      'src/b.ts': 'const NEEDLE = 3\n',
      'docs/guide.md': 'needle in docs\n',
      'nome com espaço.md': 'olá\n',
      'bin/data.bin': Buffer.from([1, 2, 0, 3]),
      'big.txt': 'x'.repeat(1_000_001),
    },
    { symlinks: { 'link.txt': '../../etc/passwd' }, submodules: ['vendor/lib'] },
  )
  mirrorParent = mkdtempSync(join(tmpdir(), 'phada-checkout-test-'))
  const mirror = await openGitMirror({
    dir: join(mirrorParent, 'shop.git'),
    owner: 'acme',
    repo: 'shop',
    token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    env: process.env,
    remoteUrl: repository.url,
  })
  checkout = mirror.checkout(await mirror.fetch(repository.sha, 'refs/phada/pull/1'))
})

afterAll(async () => {
  await checkout.close()
  repository.remove()
  rmSync(mirrorParent, { recursive: true, force: true })
})

describe('GitCheckout over the mirror', () => {
  it('reads files of the commit', async () => {
    expect(checkout.commit).toBe(repository.sha)
    expect(await checkout.readText('src/a.ts')).toBe(
      'export const a = 1\nexport const needle = 2\n',
    )
    expect(await checkout.readText('nome com espaço.md')).toBe('olá\n')
  })

  it.each([
    ['src', 'directory'],
    ['link.txt', 'symlink'],
    ['vendor/lib', 'submodule'],
    ['bin/data.bin', 'binary'],
    ['big.txt', 'too-large'],
    ['src/missing.ts', 'not-found'],
    ['src/a', 'not-found'],
  ])('refuses to read %s (%s)', async (path, reason) => {
    await expect(checkout.readText(path)).rejects.toMatchObject({
      name: 'CheckoutError',
      reason,
    })
  })

  it('greps the commit', async () => {
    expect(await checkout.grep('needle', {})).toEqual([
      { path: 'docs/guide.md', line: 1, text: 'needle in docs' },
      { path: 'src/a.ts', line: 2, text: 'export const needle = 2' },
    ])
    expect(await checkout.grep('needle', { path: '**/*.ts' })).toEqual([
      { path: 'src/a.ts', line: 2, text: 'export const needle = 2' },
    ])
    expect(await checkout.grep('needle', { path: 'src', ignoreCase: true })).toEqual([
      { path: 'src/a.ts', line: 2, text: 'export const needle = 2' },
      { path: 'src/b.ts', line: 1, text: 'const NEEDLE = 3' },
    ])
    expect(await checkout.grep('nothing-matches-this', {})).toEqual([])
  })

  it('treats a glob without a folder as matching in every folder', async () => {
    expect(await checkout.grep('needle', { path: '*.ts' })).toEqual([
      { path: 'src/a.ts', line: 2, text: 'export const needle = 2' },
    ])
  })

  it('reports an invalid pattern', async () => {
    await expect(checkout.grep('(', {})).rejects.toMatchObject({ reason: 'invalid-pattern' })
  })

  it('lists folders', async () => {
    expect(await checkout.listDir('')).toEqual([
      { name: 'big.txt', kind: 'file' },
      { name: 'bin', kind: 'dir' },
      { name: 'docs', kind: 'dir' },
      { name: 'link.txt', kind: 'symlink' },
      { name: 'nome com espaço.md', kind: 'file' },
      { name: 'src', kind: 'dir' },
      { name: 'vendor', kind: 'dir' },
    ])
    expect(await checkout.listDir('vendor')).toEqual([{ name: 'lib', kind: 'submodule' }])
    await expect(checkout.listDir('src/a.ts')).rejects.toMatchObject({ reason: 'not-directory' })
    await expect(checkout.listDir('nope')).rejects.toMatchObject({ reason: 'not-found' })
  })

  it('throws a CheckoutError', async () => {
    await expect(checkout.readText('src')).rejects.toBeInstanceOf(CheckoutError)
  })
})
