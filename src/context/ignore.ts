import picomatch from 'picomatch'
import { splitDiff } from './split-diff.js'

export const DEFAULT_IGNORE: readonly string[] = [
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lock',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/uv.lock',
  '**/Pipfile.lock',
  '**/Gemfile.lock',
  '**/composer.lock',
  '**/go.sum',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
]

export interface IgnoreResult {
  diff: string
  files: string[]
  ignored: string[]
}

export function matcher(patterns: readonly string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false
  const isMatch = picomatch([...patterns], { dot: true })
  return (path) => isMatch(path)
}

export function applyIgnore(diff: string, patterns: readonly string[]): IgnoreResult {
  const isIgnored = matcher(patterns)
  const { preamble, sections } = splitDiff(diff)
  const kept = sections.filter((section) => !isIgnored(section.path))
  return {
    diff: preamble + kept.map((section) => section.text).join(''),
    files: kept.map((section) => section.path),
    ignored: sections.filter((section) => isIgnored(section.path)).map((section) => section.path),
  }
}
