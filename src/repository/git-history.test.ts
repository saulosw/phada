import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createLocalRepository } from '../../test/support/git-repo.js'
import type { RunCommandResult } from '../process/run-command.js'
import { runCommand } from '../process/run-command.js'
import { openGitMirror } from './git-mirror.js'

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const parent = mkdtempSync(join(tmpdir(), 'phada-history-test-'))
afterAll(() => rmSync(parent, { recursive: true, force: true }))

function threeCommits() {
  const repository = createLocalRepository({ 'src/a.ts': 'one\ntwo\nthree\n', 'src/b.ts': 'b\n' })
  repository.commit({ 'src/a.ts': 'one\nTWO\nthree\n' }, 'feat: change two (#12)')
  const head = repository.commit(
    { 'src/a.ts': 'one\nTWO\nTHREE\n' },
    'Merge pull request #45 from acme/three',
  )
  return { repository, head }
}

async function mirrorOf(url: string, name: string, run = runCommand) {
  return openGitMirror({
    dir: join(parent, name, 'shop.git'),
    owner: 'acme',
    repo: 'shop',
    token: TOKEN,
    env: process.env,
    remoteUrl: url,
    run,
  })
}

describe('Checkout history', () => {
  it('deepens the shallow mirror once and lists the commits that touched a file, newest first', async () => {
    const { repository, head } = threeCommits()
    const fetches: string[][] = []
    const mirror = await mirrorOf(repository.url, 'deep', async (command, args, options) => {
      if (args.includes('fetch')) fetches.push([...args])
      return runCommand(command, args, options) as Promise<RunCommandResult>
    })
    const sha = await mirror.fetch(head, 'refs/phada/pull/3')
    const checkout = mirror.checkout(sha, { deepenAs: 'refs/phada/pull/3' })

    const history = await checkout.history('src/a.ts')
    await checkout.history('src/b.ts')

    expect(history.commits.map((commit) => commit.subject)).toEqual([
      'Merge pull request #45 from acme/three',
      'feat: change two (#12)',
      'test',
    ])
    expect(history.commits[0]).toMatchObject({ sha: head, author: 'Test' })
    expect(history.commits[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(history.truncated).toBe(false)
    expect(fetches.filter((args) => args.includes('200'))).toHaveLength(1)
    expect(fetches.flat().join(' ')).not.toContain(TOKEN)
    repository.remove()
  })

  it('tells which commit last changed each range of lines', async () => {
    const { repository, head } = threeCommits()
    const mirror = await mirrorOf(repository.url, 'blame')
    const checkout = mirror.checkout(await mirror.fetch(head, 'refs/phada/pull/4'), {
      deepenAs: 'refs/phada/pull/4',
    })

    const history = await checkout.history('src/a.ts', { from: 1, to: 3 })

    expect(history.blame?.map(({ from, to }) => `${from}-${to}`)).toEqual(['1-1', '2-2', '3-3'])
    expect(history.blame?.[2]?.sha).toBe(head)
    expect(history.commits.map((commit) => commit.subject)).toEqual([
      'Merge pull request #45 from acme/three',
      'feat: change two (#12)',
      'test',
    ])
    repository.remove()
  })

  it('answers from the shallow mirror and says the history ends there when it cannot deepen', async () => {
    const { repository, head } = threeCommits()
    const mirror = await mirrorOf(repository.url, 'offline')
    const checkout = mirror.checkout(await mirror.fetch(head, 'refs/phada/pull/5'), {
      deepenAs: 'refs/phada/pull/5',
    })
    repository.remove()

    const history = await checkout.history('src/a.ts')

    expect(history.commits.map((commit) => commit.sha)).toEqual([head])
    expect(history.truncated).toBe(true)
  })

  it('returns no commits for a path no commit touched', async () => {
    const { repository, head } = threeCommits()
    const mirror = await mirrorOf(repository.url, 'missing')
    const checkout = mirror.checkout(await mirror.fetch(head, 'refs/phada/pull/6'))

    expect(await checkout.history('src/none.ts')).toEqual({ commits: [], truncated: false })
    repository.remove()
  })
})
