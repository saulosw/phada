import { z } from 'zod'
import type { Checkout, DirEntry } from '../../repository/checkout.js'
import { toRepoPath } from '../../repository/repo-path.js'
import { qualified, RELATED_NOTE, withRepo } from './related-repo.js'
import type { RelatedCheckout, WithRepo } from './related-repo.js'
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

export function repositoryTools(
  checkout: Checkout,
  related: readonly Pick<RelatedCheckout, 'repo' | 'checkout'>[] = [],
): RegisteredTool<any>[] {
  const repos = related.map((item) => item.repo)
  const note = repos.length === 0 ? '' : RELATED_NOTE
  const checkoutOf = (repo: string | undefined) =>
    related.find((item) => item.repo === repo)?.checkout ?? checkout
  const readArgs = withRepo(ReadFileArgs, repos)
  const grepArgs = withRepo(GrepArgs, repos)
  const listArgs = withRepo(ListArgs, repos)

  const readFile: RegisteredTool<WithRepo<z.infer<typeof ReadFileArgs>>> = {
    definition: {
      name: 'read_file',
      description: `Read a text file of the repository at the pull request head, with line numbers. Returns up to ${READ_MAX_LINES} lines per call; use from and to for other lines.${note}`,
      inputSchema: inputSchemaOf(readArgs),
    },
    args: readArgs,
    run: async ({ path: input, from = 1, to, repo }) => {
      const path = toRepoPath(input, { allowRoot: false })
      const lines = splitLines(await checkoutOf(repo).readText(path))
      if (from > lines.length)
        throw new ToolFailure('out-of-range', `${path} has ${lines.length} lines`)
      const last = Math.min(to ?? lines.length, from + READ_MAX_LINES - 1, lines.length)
      const shown = lines.slice(from - 1, last).map((line, index) => `${from + index}\t${line}`)
      if (last < lines.length && to === undefined) {
        shown.push(`[lines ${from}-${last} of ${lines.length}; continue with from=${last + 1}]`)
      }
      const shownPath = qualified(repo, path)
      return { text: shown.join('\n'), paths: [shownPath], touched: [shownPath] }
    },
  }

  const grep: RegisteredTool<WithRepo<z.infer<typeof GrepArgs>>> = {
    definition: {
      name: 'grep',
      description: `Search the repository at the pull request head with an extended regular expression. Returns up to ${GREP_MAX_LINES} matching lines as path:line: text.${note}`,
      inputSchema: inputSchemaOf(grepArgs),
    },
    args: grepArgs,
    run: async ({ pattern, path: input, ignoreCase, repo }) => {
      const path = toRepoPath(input, { allowRoot: true })
      const matches = await checkoutOf(repo).grep(pattern, {
        ...(path === '' ? {} : { path }),
        ...(ignoreCase === undefined ? {} : { ignoreCase }),
      })
      if (matches.length === 0) return { text: 'no matches', paths: [], touched: [] }
      const lines = matches
        .slice(0, GREP_MAX_LINES)
        .map(
          ({ path: file, line, text }) =>
            `${qualified(repo, file)}:${line}: ${cut(text, GREP_LINE_CHARS)}`,
        )
      if (matches.length > GREP_MAX_LINES) {
        lines.push(
          `+${matches.length - GREP_MAX_LINES} more matches; narrow the pattern or the path`,
        )
      }
      const files = [
        ...new Set(matches.slice(0, GREP_MAX_LINES).map((match) => qualified(repo, match.path))),
      ]
      return { text: lines.join('\n'), paths: files, touched: files }
    },
  }

  const list: RegisteredTool<WithRepo<z.infer<typeof ListArgs>>> = {
    definition: {
      name: 'list',
      description: `List a folder of the repository at the pull request head: folders end with /, symbolic links with @. Returns up to ${LIST_MAX_ENTRIES} entries.${note}`,
      inputSchema: inputSchemaOf(listArgs),
    },
    args: listArgs,
    run: async ({ path: input, repo }): Promise<ToolOutput> => {
      const path = toRepoPath(input, { allowRoot: true })
      const entries = (await checkoutOf(repo).listDir(path))
        .map(({ name, kind }) => `${name}${KIND_MARKER[kind]}`)
        .sort()
      const shown = entries.slice(0, LIST_MAX_ENTRIES)
      if (entries.length > LIST_MAX_ENTRIES) {
        shown.push(`+${entries.length - LIST_MAX_ENTRIES} more entries`)
      }
      return {
        text: shown.join('\n'),
        paths: [qualified(repo, path === '' ? '.' : path)],
        touched: [],
      }
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
