import { describe, expect, it } from 'vitest'
import { modifiedFile } from '../../test/support/diff-sections.js'
import { loadContext } from '../context/load-context.js'
import type { ContextSources } from '../context/types.js'
import { inspectPullRequestContext, inspectRepositoryContext } from './inspect-context.js'

const FILES: Record<string, string> = {
  '.github/instructions/backend.instructions.md': '---\napplyTo: "src/backend/**"\n---\nUTC.\n',
  'AGENTS.md': 'Agents.',
}

const sources: ContextSources = {
  readTree: async () => ({
    entries: Object.entries(FILES).map(([path, text]) => ({ path, size: text.length })),
    truncated: false,
  }),
  readRepoFile: async (path) => FILES[path] ?? null,
  readLocalFile: async () => null,
  listLocalDocs: async () => null,
}

describe('inspectPullRequestContext', () => {
  it('reports the same context the review of the pull request gets', async () => {
    const input = {
      diff: modifiedFile('src/frontend/a.ts'),
      baseSha: 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      userLayers: [],
      sources,
    }

    expect(await inspectPullRequestContext(input)).toEqual((await loadContext(input)).report)
  })
})

describe('inspectRepositoryContext', () => {
  it('lists the context of a branch without evaluating scopes', async () => {
    const { report } = await inspectRepositoryContext({ ref: 'main', userLayers: [], sources })

    expect(report.docs.map(({ path, status, scope }) => [path, status, scope])).toEqual([
      ['AGENTS.md', 'listed', undefined],
      ['.github/instructions/backend.instructions.md', 'listed', ['src/backend/**']],
    ])
  })
})
