import { join } from 'node:path'
import type { LocalFileSystem } from '../config/local-files.js'
import { userRepoDir } from '../config/user-config.js'
import type { UserRepoFile } from '../config/user-config.js'
import { RULES_TEMPLATE, userRepoConfigTemplate } from './init-templates.js'

const NAME_SEGMENT = /^[\w.-]+$/

export async function ensureUserRepoFile(
  repo: string,
  file: UserRepoFile,
  deps: { env: NodeJS.ProcessEnv; home: string; files: LocalFileSystem },
): Promise<string> {
  const segments = repo.split('/')
  const [owner, name] = segments
  if (segments.length !== 2 || !isSegment(owner) || !isSegment(name)) {
    throw new Error(`Not a repository name: ${repo}`)
  }
  const dir = userRepoDir(deps.env, deps.home, owner, name)
  const path = join(dir, file)
  await deps.files.makeDir(dir)
  await deps.files.writeNew(
    path,
    file === 'config.yml'
      ? userRepoConfigTemplate(`${owner.toLowerCase()}/${name.toLowerCase()}`)
      : RULES_TEMPLATE,
  )
  return path
}

function isSegment(segment: string | undefined): segment is string {
  return segment !== undefined && NAME_SEGMENT.test(segment) && segment !== '.' && segment !== '..'
}
