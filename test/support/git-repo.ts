import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface LocalRepository {
  dir: string
  url: string
  sha: string
  remove(): void
}

export type RepositoryFiles = Record<string, string | Buffer>

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}

export function createLocalRepository(
  files: RepositoryFiles,
  options: { symlinks?: Record<string, string>; submodules?: string[] } = {},
): LocalRepository {
  const dir = mkdtempSync(join(tmpdir(), 'phada-test-repo-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { env: GIT_ENV, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'uploadpack.allowAnySHA1InWant', 'true')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  for (const [path, target] of Object.entries(options.symlinks ?? {})) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    symlinkSync(target, join(dir, path))
  }
  git('add', '-A')
  for (const path of options.submodules ?? []) {
    git('update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},${path}`)
  }
  git('commit', '-q', '--no-gpg-sign', '-m', 'test')
  return {
    dir,
    url: `file://${dir}`,
    sha: git('rev-parse', 'HEAD').trim(),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  }
}
