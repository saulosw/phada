import type { DeclaredRepository, ReviewSettings } from '../config/merge-config.js'
import type { RepositoryTree } from '../github/repository-files.js'
import type { ReviewContext } from '../review/types.js'
import type { DocCategory } from './select-docs.js'

export interface ConfigFileReport {
  path: string
  origin: 'repository' | 'user'
  status: 'loaded' | 'invalid'
  message?: string
}

export interface RuleReport {
  key: string
  origin: string
  scope: string[]
  severity?: 'P0' | 'P1' | 'P2'
  status: 'applied' | 'disabled' | 'out-of-scope' | 'listed'
}

export interface DocReport {
  path: string
  origin: 'repository' | 'local'
  category: DocCategory
  bytes: number
  status: 'included' | 'truncated' | 'omitted' | 'listed'
  reason?: 'budget' | 'binary' | 'not-found' | 'unreadable' | 'out-of-scope' | 'manual' | 'excluded'
  scope?: string[]
}

export interface ContextReport {
  configFiles: ConfigFileReport[]
  rules: RuleReport[]
  docs: DocReport[]
  ignored: string[]
  budget: { limit: number; used: number }
  warnings: string[]
}

export interface LocalDocEntry {
  path: string
  size: number
}

export interface ContextSources {
  readTree(): Promise<RepositoryTree>
  readRepoFile(path: string): Promise<string | null>
  readLocalFile(path: string): Promise<string | null>
  listLocalDocs(path: string): Promise<LocalDocEntry[] | null>
}

export interface ContextOptions {
  language?: string
  minConfidence?: number
  verify?: boolean
  investigate?: boolean
  resolveThreads?: boolean
  review?: ReviewSettings
}

export interface LoadedContext {
  diff: string
  options: ContextOptions
  context: ReviewContext
  ignore: string[]
  repos: DeclaredRepository[]
  privateOnPublic: boolean
  report: ContextReport
}
