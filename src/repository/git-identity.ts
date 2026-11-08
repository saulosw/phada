import { runCommand } from '../process/run-command.js'
import { GIT_READ_TIMEOUT_MS, promptlessGitEnvironment } from './git-checkout.js'
import type { Run } from './git-checkout.js'

export type GitSetting = readonly [key: string, value: string]

export interface GitIdentity {
  name: string
  email: string
  signing: GitSetting[]
}

export interface ReadGitIdentityOptions {
  dir: string
  env: NodeJS.ProcessEnv
  run?: Run
}

const SIGNING_SETTINGS = '^(commit\\.gpgsign|user\\.signingkey|gpg\\..+)$'

export class MissingGitIdentityError extends Error {
  override readonly name = 'MissingGitIdentityError'

  constructor(missing: readonly string[]) {
    super(
      `phada fix commits as you, and git has no ${missing.join(' and ')} here: set ${missing.length > 1 ? 'them' : 'it'} with git config --global.`,
    )
  }
}

export async function readGitIdentity(options: ReadGitIdentityOptions): Promise<GitIdentity> {
  const run = options.run ?? runCommand
  const env = promptlessGitEnvironment(options.env)
  const config = (args: readonly string[]) =>
    run('git', ['-C', options.dir, 'config', '-z', ...args], {
      env,
      timeoutMs: GIT_READ_TIMEOUT_MS,
    })
  const value = async (key: string) => {
    const result = await config(['--get', key])
    return result.exitCode === 0 ? result.stdout.replace(/\0$/, '').trim() : ''
  }
  const [name, email, signing] = await Promise.all([
    value('user.name'),
    value('user.email'),
    config(['--get-regexp', SIGNING_SETTINGS]),
  ])
  const missing = [...(name === '' ? ['user.name'] : []), ...(email === '' ? ['user.email'] : [])]
  if (missing.length > 0) throw new MissingGitIdentityError(missing)
  return { name, email, signing: signing.exitCode === 0 ? parseConfigList(signing.stdout) : [] }
}

function parseConfigList(output: string): GitSetting[] {
  return output.split('\0').flatMap((record) => {
    if (record === '') return []
    const newline = record.indexOf('\n')
    return newline === -1
      ? [[record, 'true'] as const]
      : [[record.slice(0, newline), record.slice(newline + 1)] as const]
  })
}
