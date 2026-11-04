import type { LineSpan } from '../publish/misses.js'
import type { Extractor } from '../repo-map/extract.js'
import { languageOf } from '../repo-map/languages.js'
import { remembered } from './remembered.js'

export type ReadFileAt = (repo: string, commit: string, path: string) => Promise<string | null>

export type CodeElements = (
  repo: string,
  commit: string,
  path: string,
) => Promise<readonly LineSpan[] | undefined>

export function codeElements(readFile: ReadFileAt, extractor: Extractor): CodeElements {
  const read = remembered(
    (repo: string, commit: string, path: string) => `${repo.toLowerCase()}\0${commit}\0${path}`,
    async (repo: string, commit: string, path: string) => {
      const language = languageOf(path)
      if (language === undefined) return undefined
      const text = await readFile(repo, commit, path)
      if (text === null) return undefined
      const map = await extractor.extract(language, text)
      if (map === 'timeout') return undefined
      return map.symbols
        .filter(
          ({ kind, parent }) =>
            kind !== 'parameter' && (kind !== 'variable' || parent === undefined),
        )
        .map(({ startLine, endLine }) => ({ startLine, endLine }))
    },
  )
  return (repo, commit, path) =>
    languageOf(path) === undefined ? Promise.resolve(undefined) : read(repo, commit, path)
}
