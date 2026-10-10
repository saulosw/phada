import { z } from 'zod'
import type { Checkout, DirEntry } from './checkout.js'
import { toRepoPath } from './repo-path.js'
import { inputSchemaOf, ToolFailure } from './tool-registry.js'
import type { RegisteredTool, ToolOutput } from './tool-registry.js'

export const READ_MAX_LINES = 400
export const GREP_MAX_LINES = 100
export const GREP_LINE_CHARS = 300
export const LIST_MAX_ENTRIES = 500

const LineNumber = z.number().int().min(1)

const ReadFileArgs = z.strictObject({
  path: z.string().describe('File path relative to the repository root, e.g. src/app.ts'),
  from: LineNumber.optional().describe('First line to read (default 1)'),
  to: LineNumber.optional().describe('Last line to read'),
})

const GrepArgs = z.strictObject({
  pattern: z.string().min(1).describe('Extended regular expression'),
  path: z
    .string()
    .optional()
    .describe('Folder, file or glob to search in, e.g. src or **/*.ts (default: everything)'),
  ignoreCase: z.boolean().optional(),
})

const ListArgs = z.strictObject({
  path: z.string().optional().describe('Folder relative to the repository root (default: root)'),
})

const KIND_MARKER: Readonly<Record<DirEntry['kind'], string>> = {
  file: '',
  dir: '/',
  symlink: '@',
  submodule: ' (submodule)',
}

export function repositoryTools(checkout: Checkout): RegisteredTool<any>[] {
  const readFile: RegisteredTool<z.infer<typeof ReadFileArgs>> = {
    definition: {
      name: 'read_file',
      description: `Read a text file of the repository at the pull request head, with line numbers. Returns up to ${READ_MAX_LINES} lines per call; use from and to for other lines.`,
      inputSchema: inputSchemaOf(ReadFileArgs),
    },
    args: ReadFileArgs,
    run: async ({ path: input, from = 1, to }) => {
      const path = toRepoPath(input, { allowRoot: false })
      const lines = splitLines(await checkout.readText(path))
      if (from > lines.length)
        throw new ToolFailure('out-of-range', `${path} has ${lines.length} lines`)
      const last = Math.min(to ?? lines.length, from + READ_MAX_LINES - 1, lines.length)
      const shown = lines.slice(from - 1, last).map((line, index) => `${from + index}\t${line}`)
      if (last < lines.length && to === undefined) {
        shown.push(`[lines ${from}-${last} of ${lines.length}; continue with from=${last + 1}]`)
      }
      return { text: shown.join('\n'), paths: [path], touched: [path] }
    },
  }

  const grep: RegisteredTool<z.infer<typeof GrepArgs>> = {
    definition: {
      name: 'grep',
      description: `Search the repository at the pull request head with an extended regular expression. Returns up to ${GREP_MAX_LINES} matching lines as path:line: text.`,
      inputSchema: inputSchemaOf(GrepArgs),
    },
    args: GrepArgs,
    run: async ({ pattern, path: input, ignoreCase }) => {
      const path = toRepoPath(input, { allowRoot: true })
      const matches = await checkout.grep(pattern, {
        ...(path === '' ? {} : { path }),
        ...(ignoreCase === undefined ? {} : { ignoreCase }),
      })
      if (matches.length === 0) return { text: 'no matches', paths: [], touched: [] }
      const lines = matches
        .slice(0, GREP_MAX_LINES)
        .map(({ path: file, line, text }) => `${file}:${line}: ${cut(text, GREP_LINE_CHARS)}`)
      if (matches.length > GREP_MAX_LINES) {
        lines.push(
          `+${matches.length - GREP_MAX_LINES} more matches; narrow the pattern or the path`,
        )
      }
      const files = [...new Set(matches.slice(0, GREP_MAX_LINES).map((match) => match.path))]
      return { text: lines.join('\n'), paths: files, touched: files }
    },
  }

  const list: RegisteredTool<z.infer<typeof ListArgs>> = {
    definition: {
      name: 'list',
      description: `List a folder of the repository at the pull request head: folders end with /, symbolic links with @. Returns up to ${LIST_MAX_ENTRIES} entries.`,
      inputSchema: inputSchemaOf(ListArgs),
    },
    args: ListArgs,
    run: async ({ path: input }): Promise<ToolOutput> => {
      const path = toRepoPath(input, { allowRoot: true })
      const entries = (await checkout.listDir(path))
        .map(({ name, kind }) => `${name}${KIND_MARKER[kind]}`)
        .sort()
      const shown = entries.slice(0, LIST_MAX_ENTRIES)
      if (entries.length > LIST_MAX_ENTRIES) {
        shown.push(`+${entries.length - LIST_MAX_ENTRIES} more entries`)
      }
      return { text: shown.join('\n'), paths: [path === '' ? '.' : path], touched: [] }
    },
  }

  return [readFile, grep, list]
}

function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
