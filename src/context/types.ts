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
  status: 'applied' | 'disabled' | 'out-of-scope'
}

export interface DocReport {
  path: string
  origin: 'repository' | 'local'
  category: DocCategory
  bytes: number
  status: 'included' | 'truncated' | 'omitted'
  reason?: 'budget' | 'binary' | 'not-found' | 'unreadable'
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
}

export interface LoadedContext {
  diff: string
  options: ContextOptions
  context: ReviewContext
  report: ContextReport
}
