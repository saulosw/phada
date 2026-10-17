import { describe, expect, it } from 'vitest'
import { CheckoutError } from '../../repository/checkout.js'
import type { Checkout, DirEntry, GrepMatch } from '../../repository/checkout.js'
import { repositoryTools } from './repository-tools.js'
import { ToolLog } from './tool-log.js'
import { createToolbox } from './tool-registry.js'

function memoryCheckout(
  files: Record<string, string>,
  {
    matches = [],
    entries = {},
  }: { matches?: GrepMatch[]; entries?: Record<string, DirEntry[]> } = {},
): Checkout {
  return {
    commit: 'abc',
    readText: async (path) => {
      const text = files[path]
      if (text === undefined) throw new CheckoutError('not-found', `${path} does not exist`)
      return text
    },
    grep: async () => matches,
    listDir: async (path) => {
      const list = entries[path]
      if (list === undefined) throw new CheckoutError('not-found', `${path} does not exist`)
      return list
    },
    history: async () => ({ commits: [], truncated: false }),
    close: async () => {},
  }
}

function toolboxFor(checkout: Checkout, log = new ToolLog()) {
  return createToolbox(repositoryTools(checkout), log, 'review')
}

const numbered = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')

describe('repositoryTools', () => {
  it('describes read_file, grep and list with JSON schemas', () => {
    const toolbox = toolboxFor(memoryCheckout({}))

    expect(toolbox.definitions.map((definition) => definition.name)).toEqual([
      'read_file',
      'grep',
      'list',
    ])
    for (const definition of toolbox.definitions) {
      expect(definition.inputSchema).toMatchObject({ type: 'object' })
      expect(definition.inputSchema).not.toHaveProperty('$schema')
    }
  })

  describe('read_file', () => {
    it('numbers the lines of a small file', async () => {
      const log = new ToolLog()
      const toolbox = toolboxFor(memoryCheckout({ 'src/a.ts': 'one\ntwo\n' }), log)

      expect(await toolbox.call('read_file', { path: './src/a.ts' })).toEqual({
        text: '1\tone\n2\ttwo',
        isError: false,
      })
      expect(log.records[0]).toMatchObject({ paths: ['src/a.ts'] })
      expect(toolbox.touchedPaths()).toEqual(['src/a.ts'])
    })

    it('reads 400 lines at a time and says where to continue', async () => {
      const toolbox = toolboxFor(memoryCheckout({ 'big.ts': numbered(450) }))

      const first = await toolbox.call('read_file', { path: 'big.ts' })
      const rest = await toolbox.call('read_file', { path: 'big.ts', from: 401 })

      expect(first.text.split('\n')).toHaveLength(401)
      expect(first.text.split('\n').at(-1)).toBe('[lines 1-400 of 450; continue with from=401]')
      expect(rest.text.split('\n')[0]).toBe('401\tline 401')
      expect(rest.text.split('\n').at(-1)).toBe('450\tline 450')
    })

    it('reads a range', async () => {
      const toolbox = toolboxFor(memoryCheckout({ 'a.ts': numbered(10) }))

      expect((await toolbox.call('read_file', { path: 'a.ts', from: 3, to: 4 })).text).toBe(
        '3\tline 3\n4\tline 4',
      )
    })

    it('refuses a range past the end', async () => {
      const toolbox = toolboxFor(memoryCheckout({ 'a.ts': numbered(10) }))

      expect(await toolbox.call('read_file', { path: 'a.ts', from: 11 })).toEqual({
        text: 'a.ts has 10 lines',
        isError: true,
      })
    })

    it('refuses a path outside the repository', async () => {
      const toolbox = toolboxFor(memoryCheckout({}))

      expect(await toolbox.call('read_file', { path: '../../etc/passwd' })).toEqual({
        text: '"../../etc/passwd" is not a path inside the repository',
        isError: true,
      })
    })

    it('passes checkout errors on', async () => {
      const toolbox = toolboxFor(memoryCheckout({}))

      expect(await toolbox.call('read_file', { path: 'nope.ts' })).toEqual({
        text: 'nope.ts does not exist',
        isError: true,
      })
    })
  })

  describe('grep', () => {
    it('lists matches with their file and line', async () => {
      const log = new ToolLog()
      const toolbox = toolboxFor(
        memoryCheckout(
          {},
          {
            matches: [
              { path: 'src/a.ts', line: 3, text: 'authorize(token)' },
              { path: 'src/b.ts', line: 9, text: 'x'.repeat(400) },
              { path: 'src/a.ts', line: 7, text: 'authorize(other)' },
            ],
          },
        ),
        log,
      )

      const result = await toolbox.call('grep', { pattern: 'authorize\\(' })

      expect(result.text.split('\n')).toEqual([
        'src/a.ts:3: authorize(token)',
        `src/b.ts:9: ${'x'.repeat(300)}…`,
        'src/a.ts:7: authorize(other)',
      ])
      expect(log.records[0]).toMatchObject({ paths: ['src/a.ts', 'src/b.ts'] })
    })

    it('cuts after 100 matches', async () => {
      const matches = Array.from({ length: 130 }, (_, index) => ({
        path: 'a.ts',
        line: index + 1,
        text: 'hit',
      }))
      const toolbox = toolboxFor(memoryCheckout({}, { matches }))

      const lines = (await toolbox.call('grep', { pattern: 'hit' })).text.split('\n')

      expect(lines).toHaveLength(101)
      expect(lines.at(-1)).toBe('+30 more matches; narrow the pattern or the path')
    })

    it('says when nothing matches', async () => {
      const toolbox = toolboxFor(memoryCheckout({}))

      expect(await toolbox.call('grep', { pattern: 'x' })).toEqual({
        text: 'no matches',
        isError: false,
      })
    })

    it('refuses an escaping path filter', async () => {
      const toolbox = toolboxFor(memoryCheckout({}))

      expect((await toolbox.call('grep', { pattern: 'x', path: '../**' })).isError).toBe(true)
    })
  })

  describe('list', () => {
    it('lists a folder with markers', async () => {
      const toolbox = toolboxFor(
        memoryCheckout(
          {},
          {
            entries: {
              '': [
                { name: 'src', kind: 'dir' },
                { name: 'README.md', kind: 'file' },
                { name: 'link', kind: 'symlink' },
                { name: 'vendor', kind: 'submodule' },
              ],
            },
          },
        ),
      )

      expect((await toolbox.call('list', {})).text).toBe(
        'README.md\nlink@\nsrc/\nvendor (submodule)',
      )
      expect(toolbox.touchedPaths()).toEqual([])
    })

    it('cuts after 500 entries', async () => {
      const entries = Array.from({ length: 520 }, (_, index) => ({
        name: `f${String(index).padStart(3, '0')}`,
        kind: 'file' as const,
      }))
      const toolbox = toolboxFor(memoryCheckout({}, { entries: { src: entries } }))

      const lines = (await toolbox.call('list', { path: 'src/' })).text.split('\n')

      expect(lines).toHaveLength(501)
      expect(lines.at(-1)).toBe('+20 more entries')
    })
  })
})

describe('repositoryTools with related repositories', () => {
  const related = [
    {
      repo: 'acme/web',
      checkout: memoryCheckout(
        { 'src/a.ts': 'web\n' },
        {
          matches: [{ path: 'src/a.ts', line: 1, text: 'web' }],
          entries: { '': [{ name: 'src', kind: 'dir' }] },
        },
      ),
    },
  ]

  it('adds an optional repo argument limited to the related repositories', () => {
    const toolbox = createToolbox(
      repositoryTools(memoryCheckout({}), related),
      new ToolLog(),
      'review',
    )

    for (const definition of toolbox.definitions) {
      expect(definition.inputSchema).toMatchObject({
        properties: { repo: { enum: ['acme/web'] } },
      })
      expect(definition.description).toContain('repo')
    }
  })

  it('keeps the arguments of the tools without related repositories', () => {
    for (const definition of toolboxFor(memoryCheckout({})).definitions) {
      expect(definition.inputSchema.properties).not.toHaveProperty('repo')
    }
  })

  it('reads, searches and lists a related repository, naming its paths owner/repo:path', async () => {
    const log = new ToolLog()
    const toolbox = createToolbox(
      repositoryTools(memoryCheckout({ 'src/a.ts': 'own\n' }), related),
      log,
      'review',
    )

    expect(await toolbox.call('read_file', { repo: 'acme/web', path: 'src/a.ts' })).toEqual({
      text: '1\tweb',
      isError: false,
    })
    expect((await toolbox.call('grep', { repo: 'acme/web', pattern: 'web' })).text).toBe(
      'acme/web:src/a.ts:1: web',
    )
    expect((await toolbox.call('list', { repo: 'acme/web' })).text).toBe('src/')
    expect((await toolbox.call('read_file', { path: 'src/a.ts' })).text).toBe('1\town')
    expect(log.records.map((record) => record.touched)).toEqual([
      ['acme/web:src/a.ts'],
      ['acme/web:src/a.ts'],
      [],
      ['src/a.ts'],
    ])
  })

  it('refuses an unknown repository and a path outside the related repository', async () => {
    const toolbox = createToolbox(
      repositoryTools(memoryCheckout({}), related),
      new ToolLog(),
      'review',
    )

    expect((await toolbox.call('read_file', { repo: 'acme/other', path: 'a' })).text).toMatch(
      /^Invalid arguments for read_file: repo/,
    )
    expect((await toolbox.call('read_file', { repo: 'acme/web', path: '../x' })).isError).toBe(true)
  })
})
