import { isAbsolute, join } from 'node:path'
import { ConfigError } from './errors.js'
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
    loadLayer(files, 'user', userConfigDir(env, home), ''),
    loadLayer(
      files,
      'user-repo',
      userRepoDir(env, home, owner, repo),
      `repos/${owner.toLowerCase()}/${repo.toLowerCase()}/`,
    ),
  ])
  return layers.filter((layer) => layer !== undefined)
}

async function loadLayer(
  files: LocalFileSystem,
  kind: LayerKind,
  dir: string,
  labelPrefix: string,
): Promise<ConfigLayer | undefined> {
  const configPath = join(dir, 'config.yml')
  const [configText, rulesText] = await Promise.all([
    files.readText(configPath),
    files.readText(join(dir, 'rules.md')),
  ])
  if (configText === null && rulesText === null) return undefined
  const parsed = parseConfigText(configText ?? '')
  if (!parsed.ok) throw new ConfigError(`Invalid config ${configPath}: ${parsed.message}`)
  const { localFiles, ...config } = parsed.config
  return {
    kind,
    dir: '',
    configLabel: `user:${labelPrefix}config.yml`,
    config: {
      ...config,
      ...(localFiles === undefined
        ? {}
        : { localFiles: localFiles.map((path) => fromConfigDir(dir, path)) }),
    },
    ...(rulesText === null
      ? {}
      : { rulesMarkdown: { label: `user:${labelPrefix}rules.md`, text: rulesText } }),
  }
}

function fromConfigDir(dir: string, path: string): string {
  return path === '~' || path.startsWith('~/') || isAbsolute(path) ? path : join(dir, path)
}
