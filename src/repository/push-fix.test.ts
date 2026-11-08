import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createLocalRepository } from '../../test/support/git-repo.js'
import type { RunCommandOptions, RunCommandResult } from '../process/run-command.js'
import type { GitIdentity } from './git-identity.js'
import { openLocalGit } from './local-git.js'
import { BranchMovedError } from './branch-moved.js'
import { commitWorkTree, pushCommit, PushFailedError } from './push-fix.js'

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
const BRANCH = 'feature/spend'
const ENV = { PATH: process.env.PATH }
const ANA: GitIdentity = { name: 'Ana Lima', email: 'ana@example.com', signing: [] }

const scratch = mkdtempSync(join(tmpdir(), 'phada-push-fix-'))
const removals: (() => void)[] = []
afterAll(() => {
  for (const remove of removals) remove()
  rmSync(scratch, { recursive: true, force: true })
})
let count = 0

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim()
}

async function fixedWorkTree() {
  count += 1
  const source = createLocalRepository({ 'src/shop.ts': 'spend\n' })
  removals.push(() => source.remove())
  const bare = join(scratch, `remote-${count}.git`)
  execFileSync('git', ['clone', '-q', '--bare', source.dir, bare])
  git(bare, 'branch', BRANCH, source.sha)
  const dir = join(scratch, `tree-${count}`)
  execFileSync('git', ['clone', '-q', bare, dir])
  git(dir, 'checkout', '-q', BRANCH)
  git(dir, 'remote', 'remove', 'origin')
  writeFileSync(join(dir, 'src/shop.ts'), 'spend safely\n')
  writeFileSync(join(dir, 'src/auth.ts'), 'auth\n')
  const tree = await (await openLocalGit({ dir, env: ENV })).workingTree()
  return { dir, bare, head: source.sha, tree, url: `file://${bare}` }
}

describe('commitWorkTree', { timeout: 20_000 }, () => {
  it('commits the tree on the head as the user, with the message', async () => {
    const { dir, head, tree } = await fixedWorkTree()

    const commit = await commitWorkTree({
      dir,
      tree,
      message: 'fix: address review comments\n\n- src/shop.ts:1 spends too much\n',
      identity: ANA,
      env: ENV,
    })

    expect(git(dir, 'show', '-s', '--format=%an <%ae>|%cn <%ce>|%P|%T', commit)).toBe(
      `Ana Lima <ana@example.com>|Ana Lima <ana@example.com>|${head}|${tree}`,
    )
    expect(git(dir, 'show', '-s', '--format=%B', commit)).toBe(
      'fix: address review comments\n\n- src/shop.ts:1 spends too much',
    )
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(commit)
  })

  it('signs the commit when the settings of the user sign commits', async () => {
    const { dir, tree } = await fixedWorkTree()
    const gpg = join(scratch, `gpg-${count}.sh`)
    writeFileSync(
      gpg,
      [
        '#!/bin/sh',
        'cat > /dev/null',
        'printf "\\n[GNUPG:] SIG_CREATED D 1 8 00 1 X\\n" >&2',
        'echo "-----BEGIN PGP SIGNATURE-----"',
        'echo "signed by the fake gpg"',
        'echo "-----END PGP SIGNATURE-----"',
      ].join('\n'),
    )
    chmodSync(gpg, 0o755)

    const commit = await commitWorkTree({
      dir,
      tree,
      message: 'fix: address review comments\n',
      identity: {
        ...ANA,
        signing: [
          ['commit.gpgsign', 'true'],
          ['gpg.program', gpg],
          ['user.signingkey', 'ANA'],
        ],
      },
      env: ENV,
    })

    expect(git(dir, 'cat-file', 'commit', commit)).toContain('signed by the fake gpg')
  })

  it('runs no hook of the user', async () => {
    const { dir, tree } = await fixedWorkTree()
    const home = join(scratch, `home-${count}`)
    mkdirSync(join(home, 'hooks'), { recursive: true })
    writeFileSync(join(home, '.gitconfig'), `[core]\n\thooksPath = ${join(home, 'hooks')}\n`)
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit']) {
      writeFileSync(join(home, 'hooks', hook), `#!/bin/sh\ntouch ${join(home, hook)}\nexit 1\n`)
      chmodSync(join(home, 'hooks', hook), 0o755)
    }

    const commit = await commitWorkTree({
      dir,
      tree,
      message: 'fix: address review comments\n',
      identity: ANA,
      env: { ...ENV, HOME: home },
    })

    expect(git(dir, 'rev-parse', 'HEAD')).toBe(commit)
    expect(readdirSync(home).sort()).toEqual(['.gitconfig', 'hooks'])
  })
})

describe('pushCommit', { timeout: 20_000 }, () => {
  it('pushes the commit to the branch of the remote', async () => {
    const fixed = await fixedWorkTree()
    const commit = await commitWorkTree({
      ...fixed,
      message: 'fix: address review comments\n',
      identity: ANA,
      env: ENV,
    })

    await pushCommit({
      dir: fixed.dir,
      commit,
      branch: BRANCH,
      owner: 'acme',
      repo: 'shop',
      token: TOKEN,
      remoteUrl: fixed.url,
      env: ENV,
    })

    expect(git(fixed.bare, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(commit)
  })

  it('refuses to push over a branch that moved, and leaves it as it is', async () => {
    const fixed = await fixedWorkTree()
    const other = join(scratch, `other-${count}`)
    execFileSync('git', ['clone', '-q', '--branch', BRANCH, fixed.bare, other])
    writeFileSync(join(other, 'other.txt'), 'other\n')
    git(other, 'add', '-A')
    execFileSync('git', ['-C', other, 'commit', '-q', '--no-gpg-sign', '-m', 'other'], {
      env: {
        ...ENV,
        GIT_AUTHOR_NAME: 'Bo',
        GIT_AUTHOR_EMAIL: 'bo@example.com',
        GIT_COMMITTER_NAME: 'Bo',
        GIT_COMMITTER_EMAIL: 'bo@example.com',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    })
    git(other, 'push', '-q', 'origin', BRANCH)
    const moved = git(fixed.bare, 'rev-parse', `refs/heads/${BRANCH}`)
    const commit = await commitWorkTree({
      ...fixed,
      message: 'fix: address review comments\n',
      identity: ANA,
      env: ENV,
    })

    const pushing = pushCommit({
      dir: fixed.dir,
      commit,
      branch: BRANCH,
      owner: 'acme',
      repo: 'shop',
      token: TOKEN,
      remoteUrl: fixed.url,
      env: ENV,
    })

    await expect(pushing).rejects.toBeInstanceOf(BranchMovedError)
    await expect(pushing).rejects.toThrow(
      'feature/spend moved on acme/shop since phada fix read it: nothing was pushed; run phada fix again.',
    )
    expect(git(fixed.bare, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(moved)
  })

  it('sends the token only in the environment and keeps it out of the error', async () => {
    const calls: { args: readonly string[]; options: RunCommandOptions }[] = []
    const run = async (
      _command: string,
      args: readonly string[],
      options: RunCommandOptions = {},
    ): Promise<RunCommandResult> => {
      calls.push({ args, options })
      return {
        stdout: `To https://github.com/acme/shop.git\n!\t${'c'.repeat(40)}:refs/heads/${BRANCH}\t[remote rejected] (token ${TOKEN} may not push)\nDone\n`,
        stderr: `error: failed to push (Authorization: Basic ${BASIC}) ${TOKEN}\n`,
        exitCode: 1,
        durationMs: 1,
      }
    }

    const pushing = pushCommit({
      dir: '/work/repo',
      commit: 'c'.repeat(40),
      branch: BRANCH,
      owner: 'acme',
      repo: 'shop',
      token: TOKEN,
      env: { ...ENV, GITHUB_TOKEN: TOKEN },
      run,
    })

    await expect(pushing).rejects.toBeInstanceOf(PushFailedError)
    await expect(pushing).rejects.toThrow(
      /^Could not push to acme\/shop:feature\/spend: \[remote rejected\] \(token may not push\)$/,
    )
    const [call] = calls
    expect(call?.args).toContain('https://github.com/acme/shop.git')
    expect(call?.args).toContain(`${'c'.repeat(40)}:refs/heads/${BRANCH}`)
    expect(call?.args).not.toContain('--force')
    expect(call?.args.join(' ')).not.toContain(TOKEN)
    expect(call?.args.join(' ')).not.toContain(BASIC)
    expect(call?.options.env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${BASIC}`,
    })
    expect(call?.options.env?.GITHUB_TOKEN).toBeUndefined()
  })
})
