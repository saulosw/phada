export type Language = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go'

export const LANGUAGE_LABELS: Readonly<Record<Language, string>> = {
  typescript: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  python: 'Python',
  go: 'Go',
}

const BY_EXTENSION: Readonly<Record<string, Language>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
}

export function languageOf(path: string): Language | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()]
}
