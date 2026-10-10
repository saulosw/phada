import { dirname, join, relative } from 'node:path'
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
  await deps.files.makeDir(target.dir)
  const lines: string[] = []
  for (const [name, text] of [
    ['config.yml', target.config],
    ['rules.md', RULES_TEMPLATE],
  ] as const) {
    const path = join(target.dir, name)
    const shown = target.shownFrom === undefined ? path : relative(target.shownFrom, path)
    const created = await deps.files.writeNew(path, text)
    lines.push(created ? `Created ${shown}` : `${shown} exists, left unchanged`)
  }
  return lines
}

function userTarget(command: InitCommand, deps: InitDeps): InitTarget {
  const dir =
    command.repo === undefined
      ? userConfigDir(deps.env, deps.home)
      : userRepoDir(deps.env, deps.home, command.repo.owner, command.repo.repo)
  return { dir, config: USER_CONFIG_TEMPLATE }
}

async function repositoryTarget(deps: InitDeps): Promise<InitTarget> {
  let dir = deps.cwd
  while (!(await deps.files.exists(join(dir, '.git')))) {
    const parent = dirname(dir)
    if (parent === dir) {
      throw new UsageError(
        'Not inside a git repository. Run it in your repository, or use phada init --global.',
      )
    }
    dir = parent
  }
  return { dir: join(dir, '.phada'), config: REPOSITORY_CONFIG_TEMPLATE, shownFrom: dir }
}
