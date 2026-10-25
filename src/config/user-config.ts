import { isAbsolute, join } from 'node:path'
import { ConfigError } from './errors.js'
import { userLayerLabel } from './layer-label.js'
import type { LocalFileSystem } from './local-files.js'
import { parseConfigText } from './parse-config.js'
import type { ConfigLayer, LayerKind } from './types.js'

export function userConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const explicit = env.PHADA_CONFIG_HOME?.trim()
  if (explicit) return explicit
  const xdg = env.XDG_CONFIG_HOME?.trim()
  return xdg ? join(xdg, 'phada') : join(home, '.config', 'phada')
}

export function userRepoDir(
  env: NodeJS.ProcessEnv,
  home: string,
  owner: string,
  repo: string,
): string {
  return join(userConfigDir(env, home), 'repos', owner.toLowerCase(), repo.toLowerCase())
}

export function expandHome(path: string, home: string): string {
  return path === '~' || path.startsWith('~/') ? join(home, path.slice(1)) : path
}

export async function loadUserLayers(options: {
  env: NodeJS.ProcessEnv
  home: string
  owner: string
  repo: string
  files: LocalFileSystem
}): Promise<ConfigLayer[]> {
  const { env, home, owner, repo, files } = options
  const layers = await Promise.all([
    loadLayer(files, 'user', userConfigDir(env, home)),
    loadLayer(files, 'user-repo', userRepoDir(env, home, owner, repo), { owner, repo }),
  ])
  return layers.filter((layer) => layer !== undefined)
}

export async function loadTopLevelUserLayers(options: {
  env: NodeJS.ProcessEnv
  home: string
  files: LocalFileSystem
}): Promise<ConfigLayer[]> {
  const layer = await loadLayer(options.files, 'user', userConfigDir(options.env, options.home))
  return layer === undefined ? [] : [layer]
}

async function loadLayer(
  files: LocalFileSystem,
  kind: LayerKind,
  dir: string,
  repo?: { owner: string; repo: string },
): Promise<ConfigLayer | undefined> {
  const configPath = join(dir, 'config.yml')
  const [configText, rulesText] = await Promise.all([
    files.readText(configPath),
    files.readText(join(dir, 'rules.md')),
  ])
  if (configText === null && rulesText === null) return undefined
  const parsed = parseConfigText(configText ?? '')
  if (!parsed.ok) throw new ConfigError(`Invalid config ${configPath}: ${parsed.message}`)
  const { localFiles, review, ...config } = parsed.config
  return {
    kind,
    dir: '',
    configLabel: userLayerLabel('config.yml', repo),
    config: {
      ...config,
      ...(review === undefined
        ? {}
        : {
            review: {
              ...review,
              ...(review.prompt === undefined
                ? {}
                : { prompt: { ...review.prompt, file: fromConfigDir(dir, review.prompt.file) } }),
              ...(review.readDirs === undefined
                ? {}
                : { readDirs: review.readDirs.map((path) => fromConfigDir(dir, path)) }),
            },
          }),
      ...(localFiles === undefined
        ? {}
        : { localFiles: localFiles.map((path) => fromConfigDir(dir, path)) }),
    },
    ...(rulesText === null
      ? {}
      : { rulesMarkdown: { label: userLayerLabel('rules.md', repo), text: rulesText } }),
  }
}

function fromConfigDir(dir: string, path: string): string {
  return path === '~' || path.startsWith('~/') || isAbsolute(path) ? path : join(dir, path)
}

const REPO_CONFIG_FILES = ['config.yml', 'rules.md']

export async function listUserRepoConfigs(options: {
  env: NodeJS.ProcessEnv
  home: string
  files: LocalFileSystem
}): Promise<string[]> {
  const { files } = options
  const root = join(userConfigDir(options.env, options.home), 'repos')
  const repos: string[] = []
  for (const owner of (await files.listDir(root)) ?? []) {
    for (const repo of (await files.listDir(join(root, owner))) ?? []) {
      const entries = (await files.listDir(join(root, owner, repo))) ?? []
      if (entries.some((entry) => REPO_CONFIG_FILES.includes(entry))) repos.push(`${owner}/${repo}`)
    }
  }
  return repos.sort()
}
