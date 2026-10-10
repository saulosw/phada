import type { ConfigFile } from './schema.js'

export type LayerKind = 'user' | 'user-repo' | 'repo-root' | 'repo-dir'

export interface RulesMarkdown {
  label: string
  text: string
}

export interface ConfigLayer {
  kind: LayerKind
  dir: string
  configLabel: string
  config: ConfigFile
  rulesMarkdown?: RulesMarkdown
}
