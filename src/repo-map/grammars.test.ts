import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { readGrammar } from './grammars.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-grammars-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const WASM_MAGIC = [0, 0x61, 0x73, 0x6d]

describe('readGrammar', () => {
  it('reads the grammar from the installed grammar package when none is packaged', async () => {
    const bytes = await readGrammar('python', pathToFileURL(join(dir, 'missing') + '/'))

    expect([...bytes.subarray(0, 4)]).toEqual(WASM_MAGIC)
  })

  it('prefers the packaged grammar', async () => {
    writeFileSync(join(dir, 'tree-sitter-go.wasm'), 'packaged')

    const bytes = await readGrammar('go', pathToFileURL(dir + '/'))

    expect(Buffer.from(bytes).toString()).toBe('packaged')
  })

  it.each(['typescript', 'tsx', 'javascript', 'python', 'go'] as const)(
    'finds the %s grammar',
    async (language) => {
      const bytes = await readGrammar(language, pathToFileURL(join(dir, 'missing') + '/'))
      expect([...bytes.subarray(0, 4)]).toEqual(WASM_MAGIC)
    },
  )
})
