import { escapeGlob } from '../config/merge-config.js'
import { readFrontmatter } from './frontmatter.js'

export type DocFormat = 'mdc' | 'instructions'

export type DocScope =
  | { kind: 'always' }
  | { kind: 'globs'; patterns: string[] }
  | { kind: 'manual' }
  | { kind: 'excluded' }
  | { kind: 'invalid' }

const EVERYTHING = new Set(['*', '**', '**/*'])
const REVIEW_AGENT = 'code-review'

export function docScope(format: DocFormat, text: string, dir: string): DocScope {
  const frontmatter = readFrontmatter(text)
  if (frontmatter.status === 'invalid') return { kind: 'invalid' }
  const fields = frontmatter.status === 'ok' ? frontmatter.fields : new Map<string, string[]>()
  const values = (key: string) => fields.get(key) ?? []
  if (format === 'instructions') {
    const excluded = values('excludeagent').some((agent) => agent.toLowerCase() === REVIEW_AGENT)
    if (excluded) return { kind: 'excluded' }
    return scoped(values('applyto'), dir) ?? { kind: 'manual' }
  }
  if (values('alwaysapply').some((value) => value.toLowerCase() === 'true')) {
    return { kind: 'always' }
  }
  return (
    scoped(values('globs'), dir) ??
    (values('description').length > 0 ? { kind: 'always' } : { kind: 'manual' })
  )
}

function scoped(patterns: readonly string[], dir: string): DocScope | undefined {
  const cleaned = patterns
    .map((pattern) => pattern.replace(/^\/+/, ''))
    .filter((pattern) => pattern !== '')
  if (cleaned.length === 0) return undefined
  if (dir === '' && cleaned.some((pattern) => EVERYTHING.has(pattern))) return { kind: 'always' }
  return { kind: 'globs', patterns: cleaned.map((pattern) => inFolder(pattern, dir)) }
}

function inFolder(pattern: string, dir: string): string {
  const anywhere = EVERYTHING.has(pattern)
    ? '**'
    : pattern.includes('/')
      ? pattern
      : `**/${pattern}`
  return dir === '' ? anywhere : `${escapeGlob(dir)}/${anywhere}`
}
