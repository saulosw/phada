import { Language as Grammar, Parser } from 'web-tree-sitter'
import type { Node } from 'web-tree-sitter'
import { readGrammar } from './grammars.js'
import { walkGo } from './languages/go.js'
import { walkJavaScriptLike } from './languages/javascript-like.js'
import { walkPython } from './languages/python.js'
import type { Language } from './languages.js'
import type { FileMap } from './types.js'
import { Collector } from './walk.js'

export const PARSE_TIMEOUT_MS = 2_000

export interface Extractor {
  extract(language: Language, text: string): Promise<FileMap | 'timeout'>
}

export interface ExtractorOptions {
  readGrammar?: (language: Language) => Promise<Uint8Array>
  timeoutMs?: number
  now?: () => number
}

type Walker = (root: Node, collector: Collector) => void

const WALKERS: Readonly<Record<Language, Walker>> = {
  typescript: walkJavaScriptLike,
  tsx: walkJavaScriptLike,
  javascript: walkJavaScriptLike,
  python: walkPython,
  go: walkGo,
}

let initialized: Promise<void> | undefined

export function createExtractor(options: ExtractorOptions = {}): Extractor {
  const read = options.readGrammar ?? readGrammar
  const timeoutMs = options.timeoutMs ?? PARSE_TIMEOUT_MS
  const now = options.now ?? (() => performance.now())
  const parsers = new Map<Language, Promise<Parser>>()

  function parserFor(language: Language): Promise<Parser> {
    let parser = parsers.get(language)
    if (parser === undefined) {
      parser = (initialized ??= Parser.init()).then(async () => {
        const created = new Parser()
        created.setLanguage(await Grammar.load(await read(language)))
        return created
      })
      parsers.set(language, parser)
    }
    return parser
  }

  return {
    async extract(language, text) {
      const parser = await parserFor(language)
      const started = now()
      const tree = parser.parse(text, null, {
        progressCallback: () => now() - started > timeoutMs,
      })
      if (tree === null) {
        parser.reset()
        return 'timeout'
      }
      try {
        const collector = new Collector()
        WALKERS[language](tree.rootNode, collector)
        collector.keepImportedReferences()
        collector.map.parseErrors = tree.rootNode.hasError ? countErrors(tree.rootNode) : 0
        return collector.map
      } finally {
        tree.delete()
      }
    },
  }
}

function countErrors(root: Node): number {
  const cursor = root.walk()
  let count = 0
  for (;;) {
    const node = cursor.currentNode
    if (node.isError || node.isMissing) count += 1
    if (node.hasError && cursor.gotoFirstChild()) continue
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) {
        cursor.delete()
        return count
      }
    }
  }
}
