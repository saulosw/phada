import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInteractive } from '../process/run-interactive.js'
import { withoutGitHubTokens, withTempDir } from '../providers/cli-run.js'
import { editorCommand } from './terminal-hand-off.js'

export interface EditorFiles {
  withTempDir<T>(prefix: string, use: (dir: string) => Promise<T>): Promise<T>
  readText(path: string): Promise<string>
  writeText(path: string, text: string): Promise<void>
}

export interface TextEditorDeps {
  env: NodeJS.ProcessEnv
  cwd: string
  runInteractive?: typeof runInteractive
  editorFiles?: EditorFiles
}

const DISK: EditorFiles = {
  withTempDir,
  readText: (path) => readFile(path, 'utf8'),
  writeText: (path, text) => writeFile(path, text),
}

export class EditorNotFoundError extends Error {
  override readonly name = 'EditorNotFoundError'

  constructor(command: string) {
    super(`The editor "${command}" was not found; set $VISUAL or $EDITOR to the one you use.`)
  }
}

export function textEditor(
  deps: TextEditorDeps,
  fileName: string,
): (text: string) => Promise<string | undefined> {
  const run = deps.runInteractive ?? runInteractive
  const files = deps.editorFiles ?? DISK
  return (text) =>
    files.withTempDir('phada-edit-', async (dir) => {
      const file = join(dir, fileName)
      await files.writeText(file, text)
      const { command, args } = editorCommand(deps.env, file)
      const result = await run(command, args, { cwd: deps.cwd, env: withoutGitHubTokens(deps.env) })
      if (result.kind === 'not-found') throw new EditorNotFoundError(result.command)
      return result.exitCode === 0 ? await files.readText(file) : undefined
    })
}
