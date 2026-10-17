import { z } from 'zod'
import type { Checkout, HistoryCommit } from '../../repository/checkout.js'
import { toRepoPath } from '../../repository/repo-path.js'
import { inputSchemaOf } from './tool-registry.js'
import type { RegisteredTool } from './tool-registry.js'

const SQUASH = /\(#(\d+)\)\s*$/
const MERGE = /^Merge pull request #(\d+)\b/

const LineNumber = z.number().int().min(1)

const HistoryArgs = z.strictObject({
  path: z.string().describe('File path relative to the repository root'),
  from: LineNumber.optional().describe('First line, to see who last changed these lines'),
  to: LineNumber.optional().describe('Last line (default: from)'),
})

export function pullRequestOf(subject: string): number | undefined {
  const match = MERGE.exec(subject) ?? SQUASH.exec(subject)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

export function historyTool(checkout: Checkout): RegisteredTool<z.infer<typeof HistoryArgs>> {
  return {
    definition: {
      name: 'history',
      description:
        'Show the recent commits that changed a file, or who last changed some of its lines, with the pull request each commit came from.',
      inputSchema: inputSchemaOf(HistoryArgs),
    },
    args: HistoryArgs,
    run: async ({ path: input, from, to }) => {
      const path = toRepoPath(input, { allowRoot: false })
      const range = from === undefined ? undefined : { from, to: Math.max(to ?? from, from) }
      const history = await checkout.history(path, range)
      if (history.commits.length === 0) {
        return { text: `No commits touch ${path}.`, paths: [path], touched: [] }
      }
      const lines =
        range === undefined
          ? [`Commits that changed ${path}, newest first:`]
          : [
              `Last change to each line of ${path}:${range.from}-${range.to}:`,
              ...(history.blame ?? []).map(
                ({ from: first, to: last, sha }) =>
                  `  ${first === last ? first : `${first}-${last}`} → ${sha.slice(0, 7)}`,
              ),
            ]
      lines.push(...history.commits.map(commitLine))
      if (history.truncated)
        lines.push('history ends here: the local mirror keeps the last 200 commits')
      return { text: lines.join('\n'), paths: [path], touched: [] }
    },
  }
}

function commitLine({ sha, date, author, subject }: HistoryCommit): string {
  const pullRequest = pullRequestOf(subject)
  return `${sha.slice(0, 7)} ${date} ${author} — ${subject}${pullRequest === undefined ? '' : ` (PR #${pullRequest})`}`
}
