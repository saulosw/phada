import { describe, expect, it } from 'vitest'
import type { Checkout, FileHistory, LineRange } from '../../repository/checkout.js'
import { historyTool, pullRequestOf } from './history-tool.js'
import { ToolLog } from './tool-log.js'
import { createToolbox } from './tool-registry.js'

function checkoutWith(
  history: FileHistory,
  seen: { path: string; range?: LineRange }[] = [],
): Checkout {
  return {
    commit: 'abc',
    readText: async () => '',
    grep: async () => [],
    listDir: async () => [],
    history: async (path, range) => {
      seen.push({ path, ...(range === undefined ? {} : { range }) })
      return history
    },
    close: async () => {},
  }
}

const COMMITS = [
  {
    sha: 'a'.repeat(40),
    date: '2026-10-01',
    author: 'Ana',
    subject: 'Merge pull request #45 from acme/x',
  },
  { sha: 'b'.repeat(40), date: '2026-09-30', author: 'Bia', subject: 'fix: tweak (#12)' },
  { sha: 'c'.repeat(40), date: '2026-09-01', author: 'Caio', subject: 'fix #12 in parser' },
]

describe('pullRequestOf', () => {
  it('reads the pull request of a squash or merge commit', () => {
    expect(pullRequestOf('fix: x (#123)')).toBe(123)
    expect(pullRequestOf('Merge pull request #45 from a/b')).toBe(45)
    expect(pullRequestOf('fix #12 in parser')).toBeUndefined()
  })
})

describe('history tool', () => {
  it('lists the commits of a file with the pull request each came from', async () => {
    const seen: { path: string; range?: LineRange }[] = []
    const log = new ToolLog()
    const toolbox = createToolbox(
      [historyTool(checkoutWith({ commits: COMMITS, truncated: false }, seen))],
      log,
      'review',
    )

    const result = await toolbox.call('history', { path: 'src/a.ts' })

    expect(result.text).toBe(
      [
        'Commits that changed src/a.ts, newest first:',
        'aaaaaaa 2026-10-01 Ana — Merge pull request #45 from acme/x (PR #45)',
        'bbbbbbb 2026-09-30 Bia — fix: tweak (#12) (PR #12)',
        'ccccccc 2026-09-01 Caio — fix #12 in parser',
      ].join('\n'),
    )
    expect(seen).toEqual([{ path: 'src/a.ts' }])
    expect(log.records[0]?.paths).toEqual(['src/a.ts'])
  })

  it('tells who last changed each range of lines and where the history ends', async () => {
    const seen: { path: string; range?: LineRange }[] = []
    const checkout = checkoutWith(
      {
        commits: COMMITS.slice(0, 2),
        blame: [
          { from: 10, to: 12, sha: 'a'.repeat(40) },
          { from: 13, to: 13, sha: 'b'.repeat(40) },
        ],
        truncated: true,
      },
      seen,
    )
    const toolbox = createToolbox([historyTool(checkout)], new ToolLog(), 'review')

    const result = await toolbox.call('history', { path: 'src/a.ts', from: 10, to: 13 })

    expect(result.text).toBe(
      [
        'Last change to each line of src/a.ts:10-13:',
        '  10-12 → aaaaaaa',
        '  13 → bbbbbbb',
        'aaaaaaa 2026-10-01 Ana — Merge pull request #45 from acme/x (PR #45)',
        'bbbbbbb 2026-09-30 Bia — fix: tweak (#12) (PR #12)',
        'history ends here: the local mirror keeps the last 200 commits',
      ].join('\n'),
    )
    expect(seen).toEqual([{ path: 'src/a.ts', range: { from: 10, to: 13 } }])
  })

  it('reads one line when only from is given and says when no commit touched the file', async () => {
    const seen: { path: string; range?: LineRange }[] = []
    const toolbox = createToolbox(
      [historyTool(checkoutWith({ commits: [], truncated: false }, seen))],
      new ToolLog(),
      'review',
    )

    expect((await toolbox.call('history', { path: 'x.ts', from: 4 })).text).toBe(
      'No commits touch x.ts.',
    )
    expect(seen).toEqual([{ path: 'x.ts', range: { from: 4, to: 4 } }])
    expect((await toolbox.call('history', { path: '../etc/passwd' })).isError).toBe(true)
  })
})
