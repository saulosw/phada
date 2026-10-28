import { join, relative } from 'node:path'
import { findRepositoryRoot } from '../app/repository-folder.js'
import type { InitializedFile, RepositoryInit } from '../app/repository-folder.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { userConfigDir, userRepoDir } from '../config/user-config.js'
import type { RepositoryName } from './args.js'
import { UsageError } from './errors.js'
import {
  REPOSITORY_CONFIG_TEMPLATE,
  RULES_TEMPLATE,
  USER_CONFIG_TEMPLATE,
} from './init-templates.js'

export interface InitCommand {
  global: boolean
  repo?: RepositoryName
}

export interface InitDeps {
  cwd: string
  env: NodeJS.ProcessEnv
  home: string
  files: LocalFileSystem
}

interface InitTarget {
  dir: string
  config: string
  shownFrom?: string
}

export async function runInit(command: InitCommand, deps: InitDeps): Promise<string[]> {
  const target = command.global ? userTarget(command, deps) : await repositoryTarget(deps)
  const written = await writeTemplates(target, deps.files)
  return written.map(({ path, created }) =>
    created ? `Created ${path}` : `${path} exists, left unchanged`,
  )
}

export async function initRepository(deps: InitDeps): Promise<RepositoryInit> {
  const target = await repositoryTarget(deps)
  return { root: target.shownFrom, files: await writeTemplates(target, deps.files) }
}

async function writeTemplates(
  target: InitTarget,
  files: LocalFileSystem,
): Promise<InitializedFile[]> {
  await files.makeDir(target.dir)
  const written: InitializedFile[] = []
  for (const [name, text] of [
    ['config.yml', target.config],
    ['rules.md', RULES_TEMPLATE],
  ] as const) {
    const path = join(target.dir, name)
    const created = await files.writeNew(path, text)
    written.push({
      path: target.shownFrom === undefined ? path : relative(target.shownFrom, path),
      created,
    })
  }
  return written
}

function userTarget(command: InitCommand, deps: InitDeps): InitTarget {
  const dir =
    command.repo === undefined
      ? userConfigDir(deps.env, deps.home)
      : userRepoDir(deps.env, deps.home, command.repo.owner, command.repo.repo)
  return { dir, config: USER_CONFIG_TEMPLATE }
}

async function repositoryTarget(deps: InitDeps): Promise<InitTarget & { shownFrom: string }> {
  const root = await findRepositoryRoot(deps.cwd, (path) => deps.files.exists(path))
  if (root === undefined) {
    throw new UsageError(
      'Not inside a git repository. Run it in your repository, or use phada init --global.',
    )
  }
  return { dir: join(root, '.phada'), config: REPOSITORY_CONFIG_TEMPLATE, shownFrom: root }
}
