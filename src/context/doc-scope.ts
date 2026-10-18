import { escapeGlob } from '../config/merge-config.js'
import { readFrontmatter } from './frontmatter.js'
import { matcher } from './ignore.js'

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

export function scopeMatcher(patterns: readonly string[]): (path: string) => boolean {
  const excluded = patterns.filter(isNegated).map((pattern) => pattern.slice(1))
  const included = patterns.filter((pattern) => !isNegated(pattern))
  const covers = matcher(included.length === 0 ? ['**'] : included)
  const excludes = matcher(excluded)
  return (path) => covers(path) && !excludes(path)
}

function scoped(patterns: readonly string[], dir: string): DocScope | undefined {
  const cleaned = patterns
    .map((pattern) => {
      const negated = isNegated(pattern)
      const body = (negated ? pattern.slice(1) : pattern).replace(/^\/+/, '')
      return body === '' ? '' : `${negated ? '!' : ''}${inFolder(body, dir)}`
    })
    .filter((pattern) => pattern !== '')
  if (cleaned.length === 0) return undefined
  if (dir !== '' && cleaned.every(isNegated)) cleaned.unshift(`${escapeGlob(dir)}/**`)
  const everything = dir === '' && cleaned.includes('**') && !cleaned.some(isNegated)
  return everything ? { kind: 'always' } : { kind: 'globs', patterns: cleaned }
}

function isNegated(pattern: string): boolean {
  return pattern.startsWith('!')
}

function inFolder(pattern: string, dir: string): string {
  const anywhere = EVERYTHING.has(pattern)
    ? '**'
    : pattern.includes('/')
      ? pattern
      : `**/${pattern}`
  return dir === '' ? anywhere : `${escapeGlob(dir)}/${anywhere}`
}
