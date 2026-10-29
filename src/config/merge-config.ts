import { posix } from 'node:path'
import { durationMs } from './duration.js'
import type { ConfigFile, DEBT_MODES } from './schema.js'
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

export interface DeclaredRepository {
  repo: string
  description?: string
  origin: string
}

export interface SkillEntry {
  name: string
  paths?: string[]
  mode?: 'native' | 'text'
}

export type CommandPolicySetting = 'read-only' | 'all' | string[]

export type ConfigSource = 'repository' | 'local'

export interface ReviewPromptRef {
  file: string
  mode: 'append' | 'replace'
  origin: string
  source: ConfigSource
}

export interface ReviewSkillsRef {
  entries: SkillEntry[]
  origin: string
  source: ConfigSource
}

export type DebtSetting = (typeof DEBT_MODES)[number]

export interface ReviewSettings {
  debt?: { mode: DebtSetting; origin: string }
  prompt?: ReviewPromptRef
  skills?: ReviewSkillsRef
  commands?: { policy: CommandPolicySetting; origin: string }
  readDirs?: { dirs: string[]; origin: string }
  timeoutMs?: number
}

export interface CiSettings {
  read: boolean
  waitMs: number
  onFailure: 'review' | 'skip'
  checks?: string[]
}

export const DEFAULT_CI: Readonly<CiSettings> = { read: true, waitMs: 900_000, onFailure: 'review' }

export interface EffectiveConfig {
  language?: string
  minConfidence?: number
  verify?: boolean
  investigate?: boolean
  resolveThreads?: boolean
  conversation?: boolean
  ci: CiSettings
  contextDefaults: boolean
  rules: ResolvedRule[]
  disabledRules: ReadonlySet<string>
  disabledIn: ReadonlyMap<string, string[]>
  files: DeclaredFile[]
  localFiles: LocalFileRef[]
  ignore: string[]
  repos: DeclaredRepository[]
  privateOnPublic: boolean
  review: ReviewSettings
  warnings: string[]
}

export interface ProviderChoice {
  provider: string
  model?: string
}

const DEFAULT_PROVIDER = 'claude'
const OPTION_PRECEDENCE: readonly LayerKind[] = ['user-repo', 'repo-root', 'user']
const OPTIONS = [
  'language',
  'minConfidence',
  'verify',
  'investigate',
  'resolveThreads',
  'conversation',
  'ci',
] as const
const USER_ONLY = [
  'provider',
  'model',
  'localFiles',
  'mcp',
  'watch',
  'history',
  'hooks',
  'slack',
] as const
const TOP_LEVEL_ONLY = ['watch', 'history', 'hooks', 'slack'] as const
const REVIEW_USER_ONLY = ['commands', 'readDirs', 'timeout'] as const
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
  const firstLayer = (read: (config: ConfigFile) => unknown): ConfigLayer | undefined =>
    bySpecificity.find((layer) => read(layer.config) !== undefined)

  const language = firstSet((config) => config.language)
  const minConfidence = firstSet((config) => config.minConfidence)
  const verify = firstSet((config) => config.verify)
  const investigate = firstSet((config) => config.investigate)
  const resolveThreads = firstSet((config) => config.resolveThreads)
  const conversation = firstSet((config) => config.conversation)
  const ciRead = firstSet((config) => config.ci?.read)
  const ciWait = firstSet((config) => config.ci?.wait)
  const ciOnFailure = firstSet((config) => config.ci?.onFailure)
  const ciChecks = firstSet((config) => config.ci?.checks)
  const merged: EffectiveConfig = {
    ...(language === undefined ? {} : { language }),
    ...(minConfidence === undefined ? {} : { minConfidence }),
    ...(verify === undefined ? {} : { verify }),
    ...(investigate === undefined ? {} : { investigate }),
    ...(resolveThreads === undefined ? {} : { resolveThreads }),
    ...(conversation === undefined ? {} : { conversation }),
    ci: {
      read: ciRead ?? DEFAULT_CI.read,
      waitMs: ciWait === undefined ? DEFAULT_CI.waitMs : durationMs(ciWait),
      onFailure: ciOnFailure ?? DEFAULT_CI.onFailure,
      ...(ciChecks === undefined ? {} : { checks: ciChecks }),
    },
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
    repos: relatedRepositories(bySpecificity),
    privateOnPublic: firstSet((config) => config.context?.privateOnPublic) ?? false,
    review: {
      ...debtSetting(firstLayer((config) => config.review?.debt)),
      ...reviewSettings(
        firstLayer((config) => config.review?.prompt),
        firstLayer((config) =>
          config.review?.skills?.length === 0 ? undefined : config.review?.skills,
        ),
      ),
      ...reviewUserSettings(
        firstLayer((config) => config.review?.commands),
        firstLayer((config) => config.review?.readDirs),
        firstSet((config) => config.review?.timeout),
      ),
    },
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

function debtSetting(layer: ConfigLayer | undefined): ReviewSettings {
  const mode = layer?.config.review?.debt
  return layer === undefined || mode === undefined
    ? {}
    : { debt: { mode, origin: layer.configLabel } }
}

function reviewUserSettings(
  commandsLayer: ConfigLayer | undefined,
  readDirsLayer: ConfigLayer | undefined,
  timeout: string | undefined,
): ReviewSettings {
  const commands = commandsLayer?.config.review?.commands
  const readDirs = readDirsLayer?.config.review?.readDirs
  return {
    ...(commandsLayer === undefined || commands === undefined
      ? {}
      : {
          commands: {
            policy: Array.isArray(commands) && commands.length === 0 ? 'read-only' : commands,
            origin: commandsLayer.configLabel,
          },
        }),
    ...(readDirsLayer === undefined || readDirs === undefined
      ? {}
      : { readDirs: { dirs: readDirs, origin: readDirsLayer.configLabel } }),
    ...(timeout === undefined ? {} : { timeoutMs: durationMs(timeout) }),
  }
}

function reviewSettings(
  promptLayer: ConfigLayer | undefined,
  skillsLayer: ConfigLayer | undefined,
): ReviewSettings {
  const prompt = promptLayer?.config.review?.prompt
  const skills = skillsLayer?.config.review?.skills
  return {
    ...(promptLayer === undefined || prompt === undefined
      ? {}
      : {
          prompt: {
            file: prompt.file,
            mode: prompt.mode ?? 'append',
            origin: promptLayer.configLabel,
            source: sourceOf(promptLayer),
          },
        }),
    ...(skillsLayer === undefined || skills === undefined
      ? {}
      : {
          skills: {
            entries: skills.map((entry) =>
              typeof entry === 'string'
                ? { name: entry }
                : {
                    name: entry.name,
                    ...(entry.paths === undefined ? {} : { paths: entry.paths }),
                    ...(entry.mode === undefined ? {} : { mode: entry.mode }),
                  },
            ),
            origin: skillsLayer.configLabel,
            source: sourceOf(skillsLayer),
          },
        }),
  }
}

function sourceOf(layer: ConfigLayer): ConfigSource {
  return layer.kind === 'user' || layer.kind === 'user-repo' ? 'local' : 'repository'
}

function relatedRepositories(layers: readonly ConfigLayer[]): DeclaredRepository[] {
  const byName = new Map<string, DeclaredRepository>()
  for (const layer of layers) {
    for (const entry of layer.config.context?.repos ?? []) {
      const { repo, description } = typeof entry === 'string' ? { repo: entry } : entry
      const key = repo.toLowerCase()
      const known = byName.get(key)
      if (known === undefined) {
        byName.set(key, {
          repo,
          ...(description ? { description } : {}),
          origin: layer.configLabel,
        })
      } else if (known.description === undefined && description) {
        known.description = description
      }
    }
  }
  return [...byName.values()]
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
  if (layer.kind === 'user') return layer
  if (layer.kind === 'user-repo') return withoutTopLevelKeys(layer, warnings)
  const config: ConfigFile = { ...layer.config }
  if (config.review !== undefined) {
    const review = { ...config.review }
    for (const key of REVIEW_USER_ONLY) {
      if (review[key] !== undefined) {
        warnings.push(
          `${layer.configLabel}: review.${key} is only read from your own config; ignored.`,
        )
        delete review[key]
      }
    }
    config.review = review
  }
  if (layer.kind === 'repo-dir') {
    for (const key of OPTIONS) {
      if (config[key] !== undefined) {
        warnings.push(misplacedOption(layer, key))
        delete config[key]
      }
    }
    if (config.review !== undefined) {
      warnings.push(misplacedOption(layer, 'review'))
      delete config.review
    }
    if (config.context?.defaults !== undefined) {
      warnings.push(misplacedOption(layer, 'context.defaults'))
      const { defaults: _defaults, ...rest } = config.context
      config.context = rest
    }
    if (config.context?.repos !== undefined) {
      warnings.push(misplacedOption(layer, 'context.repos'))
      const { repos: _repos, ...rest } = config.context
      config.context = rest
    }
  }
  if (layer.kind === 'repo-root' && config.review?.prompt !== undefined) {
    const file = inLayer(layer, config.review.prompt.file, warnings, false)
    const { prompt, ...rest } = config.review
    config.review = file === undefined ? rest : { ...rest, prompt: { ...prompt, file } }
  }
  if (config.context?.privateOnPublic !== undefined) {
    warnings.push(
      `${layer.configLabel}: context.privateOnPublic is only read from your own config; ignored.`,
    )
    const { privateOnPublic: _privateOnPublic, ...rest } = config.context
    config.context = rest
  }
  for (const key of USER_ONLY) {
    if (config[key] !== undefined) {
      warnings.push(`${layer.configLabel}: ${key} is only read from your own config; ignored.`)
      delete config[key]
    }
  }
  return { ...layer, config }
}

function withoutTopLevelKeys(layer: ConfigLayer, warnings: string[]): ConfigLayer {
  const config: ConfigFile = { ...layer.config }
  for (const key of TOP_LEVEL_ONLY) {
    if (config[key] !== undefined) {
      warnings.push(
        `${layer.configLabel}: ${key} is only read from your top-level config; ignored.`,
      )
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

export function escapeGlob(text: string): string {
  return text.replace(GLOB_SYNTAX, '\\$&')
}
