import { execFile, execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serveGhFacade } from './gh-server.js'
import type { GhFacade } from './gh-server.js'
import type { GhPullData, ReadGitHub } from './types.js'

const DATA: GhPullData = {
  repo: 'acme/shop',
  number: 12,
  url: 'https://github.com/acme/shop/pull/12',
  title: 'Spend crystals',
  body: '',
  author: 'dev',
  baseRef: 'main',
  headRef: 'feat/spend',
  mergeBase: 'b'.repeat(40),
  headSha: 'h'.repeat(40),
  diff: '',
  viewer: 'me',
}

let facade: GhFacade | undefined
let cwd: string
let outside: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'phada-gh-cwd-'))
  outside = mkdtempSync(join(tmpdir(), 'phada-gh-outside-'))
})

afterEach(async () => {
  await facade?.close()
  facade = undefined
  rmSync(cwd, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

async function start(read: ReadGitHub = async () => ({}), maxReads?: number) {
  facade = await serveGhFacade({
    data: DATA,
    readGitHub: read,
    execArgv: ['--import', import.meta.resolve('tsx')],
    ...(maxReads === undefined ? {} : { maxReads }),
  })
  return facade
}

function run(
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      join(facade?.binDir ?? '', 'gh'),
      args,
      { cwd, env: { ...process.env, ...facade?.env } },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, code: error === null ? 0 : Number(error.code ?? 1) })
      },
    )
    if (input !== undefined) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

describe('serveGhFacade', () => {
  it('answers gh through the bridge', async () => {
    await start()

    expect(await run(['pr', 'view', '--json', 'title', '--jq', '.title'])).toEqual({
      stdout: 'Spend crystals\n',
      stderr: '',
      code: 0,
    })
  })

  it('captures a body file inside the work tree', async () => {
    const gh = await start()
    writeFileSync(join(cwd, 'note.md'), 'Found an issue.')

    const result = await run(['pr', 'comment', '--body-file', 'note.md'])

    expect(result.code).toBe(0)
    expect(gh.captured()).toEqual([
      { command: 'gh pr comment', body: 'Found an issue.', comments: [] },
    ])
  })

  it('captures a body from stdin', async () => {
    const gh = await start()

    await run(['pr', 'comment', '-F', '-'], 'Piped.')

    expect(gh.captured()).toEqual([{ command: 'gh pr comment', body: 'Piped.', comments: [] }])
  })

  it('refuses a body file outside the work tree, also through a symlink', async () => {
    const gh = await start()
    writeFileSync(join(outside, 'secret.md'), 'token')
    mkdirSync(join(cwd, 'sub'))
    symlinkSync(join(outside, 'secret.md'), join(cwd, 'sub', 'link.md'))

    for (const path of [
      join(outside, 'secret.md'),
      '../' + outside.split('/').pop() + '/secret.md',
      'sub/link.md',
    ]) {
      const result = await run(['pr', 'comment', '--body-file', path])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('phada: only files inside the checkout can be read')
    }
    expect(gh.captured()).toEqual([])
  })

  it('stops reading GitHub after the limit', async () => {
    await start(async () => ({ name: 'shop' }), 2)

    await run(['repo', 'view', '--json', 'name'])
    await run(['repo', 'view', '--json', 'name'])
    const third = await run(['repo', 'view', '--json', 'name'])

    expect(third.code).toBe(1)
    expect(third.stderr).toBe('phada: the GitHub read limit of this review was reached.\n')
  })

  it('gives each pass its own read limit', async () => {
    const gh = await start(async () => ({ name: 'shop' }), 1)

    await run(['repo', 'view', '--json', 'name'])
    gh.resetReads()
    const again = await run(['repo', 'view', '--json', 'name'])

    expect(again.code).toBe(0)
  })

  it('makes gh executable and removes everything on close', async () => {
    const gh = await start()
    const bin = join(gh.binDir, 'gh')

    expect(statSync(bin).mode & 0o111).not.toBe(0)
    expect(gh.env.PATH).toBeUndefined()
    expect(gh.env.GH_CONFIG_DIR).toBeDefined()
    expect(existsSync(gh.env.GH_CONFIG_DIR ?? '')).toBe(true)
    await gh.close()
    facade = undefined
    expect(existsSync(bin)).toBe(false)
  })
})

describe('serveGhFacade git guard', () => {
  it('runs the real git and refuses unsafe options', async () => {
    const gh = await start()
    execFileSync('git', ['init', '-q'], { cwd })
    writeFileSync(join(cwd, 'a.ts'), 'spend\n')
    execFileSync('git', ['add', 'a.ts'], { cwd })

    const git = (args: string[]) =>
      new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
        execFile(
          join(gh.binDir, 'git'),
          args,
          { cwd, env: { ...process.env, ...gh.env } },
          (error, stdout, stderr) =>
            resolve({ stdout, stderr, code: error === null ? 0 : Number(error.code ?? 1) }),
        )
      })

    expect(await git(['ls-files'])).toMatchObject({ stdout: 'a.ts\n', code: 0 })
    const refused = await git(['grep', '-Otouch pwned', 'spend'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('phada: git -O is not available')
    expect(existsSync(join(cwd, 'pwned'))).toBe(false)
  })

  it('drops git variables that could run a program', async () => {
    const gh = await start()
    execFileSync('git', ['init', '-q'], { cwd })
    writeFileSync(join(cwd, 'a.ts'), 'one\n')
    execFileSync('git', ['add', 'a.ts'], { cwd })
    writeFileSync(join(cwd, 'a.ts'), 'two\n')

    const result = await new Promise<{ stdout: string; code: number }>((resolve) => {
      execFile(
        join(gh.binDir, 'git'),
        ['diff'],
        {
          cwd,
          env: {
            ...process.env,
            ...gh.env,
            GIT_CONFIG_PARAMETERS: "'diff.external=touch pwned-env'",
          },
        },
        (error, stdout) => resolve({ stdout, code: error === null ? 0 : Number(error.code ?? 1) }),
      )
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('+two')
    expect(existsSync(join(cwd, 'pwned-env'))).toBe(false)
  })
})

describe('serveGhFacade root', () => {
  it('refuses a body file outside the checkout even when gh runs from another folder', async () => {
    facade = await serveGhFacade({
      data: DATA,
      readGitHub: async () => ({}),
      execArgv: ['--import', import.meta.resolve('tsx')],
      root: cwd,
    })
    writeFileSync(join(outside, 'secret.md'), 'token')

    const result = await new Promise<{ stderr: string; code: number }>((resolve) => {
      execFile(
        join(facade?.binDir ?? '', 'gh'),
        ['pr', 'comment', '--body-file', 'secret.md'],
        { cwd: outside, env: { ...process.env, ...facade?.env } },
        (error, _stdout, stderr) =>
          resolve({ stderr, code: error === null ? 0 : Number(error.code ?? 1) }),
      )
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('phada: only files inside the checkout can be read')
    expect(facade.captured()).toEqual([])
  })
})
