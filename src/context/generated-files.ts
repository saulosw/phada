import picomatch from 'picomatch'

export const GITATTRIBUTES = '.gitattributes'

const ATTRIBUTE = 'linguist-generated'

interface GeneratedRule {
  matches: (path: string) => boolean
  generated: boolean
}

export function generatedFiles(gitattributes: string, files: readonly string[]): string[] {
  const rules = gitattributes.split(/\r?\n/).flatMap(ruleOf)
  return files.filter((file) =>
    rules.reduce((generated, rule) => (rule.matches(file) ? rule.generated : generated), false),
  )
}

function ruleOf(line: string): GeneratedRule[] {
  const [pattern, ...attributes] = line.trim().split(/\s+/)
  if (pattern === undefined || pattern === '' || pattern.startsWith('#')) return []
  if (pattern.startsWith('!') || pattern.endsWith('/')) return []
  const states = attributes.flatMap(stateOf)
  const generated = states.at(-1)
  if (generated === undefined) return []
  return [{ matches: patternMatcher(pattern), generated }]
}

function stateOf(attribute: string): boolean[] {
  if (attribute === ATTRIBUTE || attribute === `${ATTRIBUTE}=true`) return [true]
  if (
    attribute === `-${ATTRIBUTE}` ||
    attribute === `!${ATTRIBUTE}` ||
    attribute.startsWith(`${ATTRIBUTE}=`)
  ) {
    return [false]
  }
  return []
}

function patternMatcher(pattern: string): (path: string) => boolean {
  const anchored = pattern.includes('/')
  return picomatch(anchored ? pattern.replace(/^\//, '') : pattern, {
    dot: true,
    basename: !anchored,
  })
}
