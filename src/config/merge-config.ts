import { posix } from 'node:path'
import type { ConfigFile } from './schema.js'
import type { ConfigLayer, LayerKind } from './types.js'

export interface ResolvedRule {
  key: string
  text: string
  scope: string[]
  severity?: 'P0' | 'P1' | 'P2'
  origin: string
}

export interface DeclaredFile {
  pattern: string
  origin: string
}

export interface LocalFileRef {
  path: string
  origin: string
}

export interface EffectiveConfig {
  language?: string
  minConfidence?: number
  verify?: boolean
  contextDefaults: boolean
  rules: ResolvedRule[]
  disabledRules: ReadonlySet<string>
  disabledIn: ReadonlyMap<string, string[]>
  files: DeclaredFile[]
  localFiles: LocalFileRef[]
  ignore: string[]
  warnings: string[]
}

export interface ProviderChoice {
  provider: string
  model?: string
}

const DEFAULT_PROVIDER = 'claude'
const OPTION_PRECEDENCE: readonly LayerKind[] = ['user-repo', 'repo-root', 'user']
const OPTIONS = ['language', 'minConfidence', 'verify'] as const
const USER_ONLY = ['provider', 'model', 'localFiles'] as const
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const GLOB_SYNTAX = /[()[\]{}*?!+@\\]/g
const GLOB_CHARS = /[*?[\]{}!]/

export function mergeConfig(layers: readonly ConfigLayer[]): EffectiveConfig {
  const warnings: string[] = []
  const usable = layers.map((layer) => withoutMisplacedKeys(layer, warnings))
  const bySpecificity = OPTION_PRECEDENCE.flatMap((kind) =>
    usable.filter((layer) => layer.kind === kind),
  )
  const firstSet = <T>(read: (config: ConfigFile) => T | undefined): T | undefined =>
    bySpecificity.map((layer) => read(layer.config)).find((value) => value !== undefined)

  const language = firstSet((config) => config.language)
  const minConfidence = firstSet((config) => config.minConfidence)
  const verify = firstSet((config) => config.verify)
  const merged: EffectiveConfig = {
    ...(language === undefined ? {} : { language }),
    ...(minConfidence === undefined ? {} : { minConfidence }),
    ...(verify === undefined ? {} : { verify }),
    contextDefaults: firstSet((config) => config.context?.defaults) ?? true,
    rules: [],
    disabledRules: new Set(
      usable
        .filter((layer) => layer.kind !== 'repo-dir')
        .flatMap((layer) => layer.config.disabledRules ?? []),
    ),
    disabledIn: disabledInFolders(usable),
    files: [],
    localFiles: [],
    ignore: [],
    warnings,
  }
  for (const layer of usable) {
    merged.rules.push(...rulesOf(layer, warnings))
    for (const file of layer.config.context?.files ?? []) {
      const pattern = inLayer(layer, file.path, warnings, GLOB_CHARS.test(file.path))
      if (pattern !== undefined) merged.files.push({ pattern, origin: layer.configLabel })
    }
    for (const glob of layer.config.ignore ?? []) {
      const pattern = inLayer(layer, glob, warnings, true)
      if (pattern !== undefined) merged.ignore.push(pattern)
    }
    for (const path of layer.config.localFiles ?? []) {
      merged.localFiles.push({ path, origin: layer.configLabel })
    }
  }
  return merged
}

export function resolveProvider(
  flags: { provider?: string; model?: string },
  userLayers: readonly ConfigLayer[],
): ProviderChoice {
  const configs = (['user-repo', 'user'] as const).flatMap((kind) =>
    userLayers.filter((layer) => layer.kind === kind).map((layer) => layer.config),
  )
  const source = [flags, ...configs].find((candidate) => candidate.provider !== undefined)
  const model =
    flags.model ??
    (source === undefined ? configs.find((config) => config.model)?.model : source.model)
  const provider = source?.provider ?? DEFAULT_PROVIDER
  return model === undefined ? { provider } : { provider, model }
}

function disabledInFolders(layers: readonly ConfigLayer[]): Map<string, string[]> {
  const folders = new Map<string, string[]>()
  for (const layer of layers) {
    if (layer.kind !== 'repo-dir') continue
    for (const id of layer.config.disabledRules ?? []) {
      folders.set(id, [...(folders.get(id) ?? []), `${escapeGlob(layer.dir)}/**`])
    }
  }
  return folders
}

function withoutMisplacedKeys(layer: ConfigLayer, warnings: string[]): ConfigLayer {
  if (layer.kind === 'user' || layer.kind === 'user-repo') return layer
  const config: ConfigFile = { ...layer.config }
  if (layer.kind === 'repo-dir') {
    for (const key of OPTIONS) {
      if (config[key] !== undefined) {
        warnings.push(misplacedOption(layer, key))
        delete config[key]
      }
    }
    if (config.context?.defaults !== undefined) {
      warnings.push(misplacedOption(layer, 'context.defaults'))
      const { files } = config.context
      config.context = files === undefined ? {} : { files }
    }
  }
  for (const key of USER_ONLY) {
    if (config[key] !== undefined) {
      warnings.push(`${layer.configLabel}: ${key} is only read from your own config; ignored.`)
      delete config[key]
    }
  }
  return { ...layer, config }
}

function misplacedOption(layer: ConfigLayer, key: string): string {
  return `${layer.configLabel}: ${key} is only read from the root .phada/config.yml or your own config; ignored.`
}

function rulesOf(layer: ConfigLayer, warnings: string[]): ResolvedRule[] {
  const defaultScope = layer.kind === 'repo-dir' ? [`${escapeGlob(layer.dir)}/**`] : ['**']
  const rules: ResolvedRule[] = (layer.config.rules ?? []).map((rule, index) => ({
    key: rule.id ?? `${layer.configLabel}#${index + 1}`,
    text: rule.rule,
    scope:
      rule.scope === undefined
        ? defaultScope
        : rule.scope.flatMap((glob) => inLayer(layer, glob, warnings, true) ?? []),
    ...(rule.severity === undefined ? {} : { severity: rule.severity }),
    origin: layer.configLabel,
  }))
  const markdown = layer.rulesMarkdown
  const text = markdown?.text.replace(HTML_COMMENT, '').trim() ?? ''
  if (markdown !== undefined && text !== '') {
    rules.push({
      key: markdown.label,
      text,
      scope: defaultScope,
      origin: markdown.label,
    })
  }
  return rules
}

function inLayer(
  layer: ConfigLayer,
  path: string,
  warnings: string[],
  asGlob: boolean,
): string | undefined {
  const relative = path.replace(/^\/+/, '')
  const inSubfolder = layer.kind === 'repo-dir'
  const joined = posix.normalize(inSubfolder ? posix.join(layer.dir, relative) : relative)
  const outside = inSubfolder
    ? !joined.startsWith(`${layer.dir}/`)
    : joined === '..' || joined.startsWith('../')
  if (outside) {
    const where = inSubfolder ? layer.dir : 'the repository'
    warnings.push(`${layer.configLabel}: ${path} is outside ${where}; ignored.`)
    return undefined
  }
  return inSubfolder && asGlob
    ? `${escapeGlob(layer.dir)}${joined.slice(layer.dir.length)}`
    : joined
}

function escapeGlob(text: string): string {
  return text.replace(GLOB_SYNTAX, '\\$&')
}
