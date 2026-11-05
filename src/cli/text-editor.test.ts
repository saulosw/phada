import { describe, expect, it } from 'vitest'
import type { runInteractive } from '../process/run-interactive.js'
import { textEditor } from './text-editor.js'
import type { EditorFiles } from './text-editor.js'

function memoryFiles() {
  const files = new Map<string, string>()
  const removed: string[] = []
  const editorFiles: EditorFiles = {
    withTempDir: async (prefix, use) => {
      const dir = `/tmp/${prefix}1`
      try {
        return await use(dir)
      } finally {
        removed.push(dir)
      }
    },
    readText: async (path) => files.get(path) ?? '',
    writeText: async (path, text) => {
      files.set(path, text)
    },
  }
  return { files, removed, editorFiles }
}

describe('textEditor', () => {
  it('writes the text to a file of a temporary folder, opens it and reads what was saved', async () => {
    const memory = memoryFiles()
    const shown: string[] = []
    const run: typeof runInteractive = async (_command, args) => {
      const file = args.at(-1) ?? ''
      shown.push(`${file}: ${memory.files.get(file)}`)
      memory.files.set(file, 'edited')
      return { kind: 'exited', exitCode: 0 }
    }
    const edit = textEditor(
      { env: { EDITOR: 'vi' }, cwd: '/work', runInteractive: run, editorFiles: memory.editorFiles },
      'lesson-2.yml',
    )

    expect(await edit('draft')).toBe('edited')
    expect(shown).toEqual(['/tmp/phada-edit-1/lesson-2.yml: draft'])
    expect(memory.removed).toEqual(['/tmp/phada-edit-1'])
  })

  it('reads nothing when the editor ends with an error', async () => {
    const memory = memoryFiles()
    const run: typeof runInteractive = async () => ({ kind: 'exited', exitCode: 1 })
    const edit = textEditor(
      { env: {}, cwd: '/work', runInteractive: run, editorFiles: memory.editorFiles },
      'lesson-2.yml',
    )

    expect(await edit('draft')).toBeUndefined()
  })
})
