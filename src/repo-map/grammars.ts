import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { Language } from './languages.js'

export const GRAMMAR_FILES: Readonly<Record<Language, { packageName: string; file: string }>> = {
  typescript: { packageName: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  tsx: { packageName: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
  javascript: { packageName: 'tree-sitter-javascript', file: 'tree-sitter-javascript.wasm' },
  python: { packageName: 'tree-sitter-python', file: 'tree-sitter-python.wasm' },
  go: { packageName: 'tree-sitter-go', file: 'tree-sitter-go.wasm' },
}

const PACKAGED_DIR = new URL('../grammars/', import.meta.url)

export async function readGrammar(
  language: Language,
  packagedDir: URL = PACKAGED_DIR,
): Promise<Uint8Array> {
  const { packageName, file } = GRAMMAR_FILES[language]
  try {
    return await readFile(new URL(file, packagedDir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return readFile(createRequire(import.meta.url).resolve(`${packageName}/${file}`))
}
