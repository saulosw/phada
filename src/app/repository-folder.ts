import { dirname, join } from 'node:path'

export type RepositoryFolder =
  | { kind: 'outside' }
  | { kind: 'configured'; root: string }
  | { kind: 'unconfigured'; root: string }

export interface InitializedFile {
  path: string
  created: boolean
}

export interface RepositoryInit {
  root: string
  files: InitializedFile[]
}

type Exists = (path: string) => Promise<boolean>

export async function findRepositoryRoot(cwd: string, exists: Exists): Promise<string | undefined> {
  let dir = cwd
  while (!(await exists(join(dir, '.git')))) {
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return dir
}

export async function readRepositoryFolder(cwd: string, exists: Exists): Promise<RepositoryFolder> {
  const root = await findRepositoryRoot(cwd, exists)
  if (root === undefined) return { kind: 'outside' }
  return (await exists(join(root, '.phada')))
    ? { kind: 'configured', root }
    : { kind: 'unconfigured', root }
}
