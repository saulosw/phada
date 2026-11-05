import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { nodeFileSystem } from '../config/local-files.js'
import type { ReviewPrompt } from '../providers/types.js'
import type { Miss } from '../publish/misses.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import { InvalidLessonEditError, LessonNotFoundError } from '../app/decide-lesson.js'
import { UsageError } from './errors.js'
import { EditorNotFoundError } from './text-editor.js'
import { runLessons, runLessonsAccept, runLessonsDiscard } from './lessons-command.js'
import type { LessonsCommand, LessonsCommandDeps } from './lessons-command.js'
import type { ProviderOptions } from './provider-choice.js'
import type { runInteractive } from '../process/run-interactive.js'

const root = mkdtempSync(join(tmpdir(), 'phada-lessons-command-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let dirs = 0

const NOW = new Date('2026-11-04T10:00:00.000Z')
const LIST: LessonsCommand = { all: false, refresh: false, format: 'text' }

function miss(threadId: string, overrides: Partial<Miss> = {}): Miss {
  return {
    key: threadId,
    origin: 'person',
    seen: 'missed-live',
    repo: 'acme/shop',
    number: 3,
    commitSha: 'c'.repeat(40),
    threadId,
    threadUrl: `https://github.com/acme/shop/pull/3#${threadId}`,
    file: 'src/api/orders.ts',
    line: 20,
    author: 'alice',
    role: 'member',
    body: `Comment ${threadId}.`,
    createdAt: '2026-10-20T10:00:00Z',
    ...overrides,
  }
}

function harness(config: Record<string, string> = {}, answer: unknown = { lessons: [] }) {
  const data = join(root, `d${++dirs}`)
  const out: string[] = []
  const err: string[] = []
  const providers: { name: string; options: ProviderOptions }[] = []
  const prompts: ReviewPrompt[] = []
  const memory = memoryFiles(config)
  const deps: LessonsCommandDeps = {
    env: { PHADA_CONFIG_HOME: '/cfg', PHADA_DATA_HOME: data },
    home: '/home/u',
    cwd: root,
    files: { ...memory, exists: (path) => nodeFileSystem.exists(path) },
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    clock: () => NOW,
    openHistoryStore: (path) => openHistoryStore(path),
    createProvider: (name, options) => {
      providers.push({ name, options })
      return {
        id: name,
        review: async (prompt) => {
          prompts.push(prompt)
          return { text: JSON.stringify(answer), durationMs: 1 }
        },
      }
    },
  }
  const seed = async (seeding: (store: HistoryStore) => void) => {
    const store = await openHistoryStore(join(data, 'history.sqlite'))
    try {
      seeding(store)
    } finally {
      store.close()
    }
  }
  return { deps, out, err, providers, prompts, seed, memory }
}

describe('runLessons', () => {
  it('says there is nothing yet when the history does not exist', async () => {
    const { deps, out } = harness()

    await runLessons(LIST, deps)

    expect(out.join('')).toBe(
      'No lessons in the history yet; phada lessons --refresh proposes them from the misses.\n',
    )
  })

  it('lists the pending lessons, the ones with more misses first', async () => {
    const { deps, out, seed } = harness()
    await seed((store) => {
      store.recordMisses([miss('A'), miss('B'), miss('C')], '2026-11-01T00:00:00Z')
      const [a, b, c] = store.misses({}).misses.map(({ id }) => id)
      store.recordLessons(
        {
          repo: 'acme/shop',
          created: [
            { rule: 'One miss.', scope: ['src/**'], missIds: [a ?? 0] },
            { rule: 'Two misses.', scope: ['src/**'], missIds: [b ?? 0, c ?? 0] },
          ],
          attached: [],
        },
        '2026-11-02T00:00:00Z',
      )
    })

    await runLessons(LIST, deps)

    const text = out.join('')
    expect(text.indexOf('Two misses.')).toBeLessThan(text.indexOf('One miss.'))
    expect(text).toContain('https://github.com/acme/shop/pull/3#B')
  })

  it('proposes lessons with the provider and model of the config of that repository', async () => {
    const { deps, out, err, providers, prompts, seed } = harness(
      {
        '/cfg/config.yml': 'provider: claude\n',
        '/cfg/repos/acme/shop/config.yml':
          'provider: codex\nmodel: gpt-b\nrules:\n  - id: no-console\n    scope: ["src/**"]\n    rule: Do not log with console.\n',
      },
      {
        lessons: [{ rule: 'Validate bodies.', scope: ['src/api/**'], misses: [1], extends: null }],
      },
    )
    await seed((store) => store.recordMisses([miss('A')], '2026-11-01T00:00:00Z'))

    await runLessons({ ...LIST, refresh: true, repo: { owner: 'Acme', repo: 'Shop' } }, deps)

    expect(providers).toEqual([{ name: 'codex', options: { model: 'gpt-b' } }])
    expect(prompts[0]?.data).toContain('Do not log with console.')
    expect(err.join('')).toContain('acme/shop')
    expect(out.join('')).toContain('Validate bodies.')
  })

  it('refuses --refresh when the history is off', async () => {
    const { deps } = harness({ '/cfg/config.yml': 'history: false\n' })

    await expect(runLessons({ ...LIST, refresh: true }, deps)).rejects.toThrow(
      new UsageError('--refresh saves to the history; remove history: false from your config.'),
    )
  })
})

async function seedLesson(seed: ReturnType<typeof harness>['seed']): Promise<number> {
  let lessonId = 0
  await seed((store) => {
    store.recordMisses([miss('A')], '2026-11-01T00:00:00Z')
    const missIds = store.misses({}).misses.map(({ id }) => id)
    lessonId =
      store.recordLessons(
        {
          repo: 'acme/shop',
          created: [{ rule: 'Validate bodies.', scope: ['src/api/**'], missIds }],
          attached: [],
        },
        '2026-11-02T00:00:00Z',
      )[0] ?? 0
  })
  return lessonId
}

describe('runLessonsAccept', () => {
  it('writes the rule in your config for the repository and says where', async () => {
    const { deps, out, err, seed, memory } = harness()
    const id = await seedLesson(seed)

    await runLessonsAccept({ id, edit: false }, deps)

    const path = '/cfg/repos/acme/shop/config.yml'
    expect(memory.files.get(path)).toContain(
      `rules:\n  - id: lesson-${id}\n    rule: Validate bodies.\n`,
    )
    expect(memory.files.get(path)).toMatch(/^# Your own Phada config for acme\/shop/)
    expect(err.join('')).toBe(
      `Created ${path} with the rule lesson-${id}; reviews of acme/shop apply it from now on.\n`,
    )
    await runLessons({ ...LIST, all: true }, deps)
    expect(out.join('')).toMatch(new RegExp(`${id}\\s+acme/shop\\s+accepted`))
  })

  it('says it added the rule to a config that was there', async () => {
    const path = '/cfg/repos/acme/shop/config.yml'
    const { deps, err, seed } = harness({ [path]: 'minConfidence: 70\n' })
    const id = await seedLesson(seed)

    await runLessonsAccept({ id, edit: false }, deps)

    expect(err.join('')).toBe(
      `Added the rule lesson-${id} to ${path}; reviews of acme/shop apply it from now on.\n`,
    )
  })

  it('refuses a lesson when there is no history', async () => {
    const { deps } = harness()

    await expect(runLessonsAccept({ id: 3, edit: false }, deps)).rejects.toThrow(
      LessonNotFoundError,
    )
  })
})

interface EditorCall {
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  shown: string
  file: string
}

function editor(rewrite: (shown: string) => string, exitCode = 0) {
  const calls: EditorCall[] = []
  const run: typeof runInteractive = async (command, args, options) => {
    const file = args.at(-1) ?? ''
    const shown = readFileSync(file, 'utf8')
    calls.push({ command, args, env: options.env, shown, file })
    writeFileSync(file, rewrite(shown))
    return { kind: 'exited', exitCode }
  }
  return { run, calls }
}

describe('runLessonsAccept --edit', () => {
  const path = '/cfg/repos/acme/shop/config.yml'

  it('writes the rule as edited and keeps the edited text on the lesson', async () => {
    const { deps, out, err, seed, memory } = harness()
    const id = await seedLesson(seed)
    const { run, calls } = editor(() => 'rule: Validate every body.\nscope:\n  - src/**\n')

    await runLessonsAccept(
      { id, edit: true },
      {
        ...deps,
        env: { ...deps.env, VISUAL: 'code --wait', GITHUB_TOKEN: 't' },
        runInteractive: run,
      },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('code')
    expect(calls[0]?.args.slice(0, -1)).toEqual(['--wait'])
    expect(calls[0]?.env.GITHUB_TOKEN).toBeUndefined()
    expect(calls[0]?.shown).toContain('# https://github.com/acme/shop/pull/3#A\n')
    expect(calls[0]?.shown).toContain('rule: Validate bodies.\nscope:\n  - src/api/**\n')
    expect(calls[0]?.shown).toMatch(/^#.*empty.*cancel/im)
    expect(existsSync(calls[0]?.file ?? '')).toBe(false)
    expect(memory.files.get(path)).toContain(
      `  - id: lesson-${id}\n    rule: Validate every body.\n    scope:\n      - src/**\n    from:\n      - https://github.com/acme/shop/pull/3#A\n`,
    )
    expect(err.join('')).toBe(
      `Created ${path} with the rule lesson-${id}; reviews of acme/shop apply it from now on.\n`,
    )
    await runLessons({ ...LIST, all: true }, deps)
    expect(out.join('')).toContain('Validate every body.')
    expect(out.join('')).not.toContain('Validate bodies.')
  })

  it.each([
    ['an empty rule', 'rule: ""\nscope: [src/**]\n', 'rule:'],
    ['no scope', 'rule: Validate.\n', 'scope:'],
    ['an exception glob', 'rule: Validate.\nscope: ["!src/**"]\n', 'scope.0:'],
    ['an id of its own', 'rule: Validate.\nscope: [src/**]\nid: mine\n', 'id'],
    ['broken YAML', 'rule: [\n', 'Flow sequence'],
  ])('writes nothing and keeps the lesson pending for %s', async (_, saved, key) => {
    const { deps, out, seed, memory } = harness()
    const id = await seedLesson(seed)
    const { run } = editor(() => saved)

    const accepting = runLessonsAccept({ id, edit: true }, { ...deps, runInteractive: run })

    await expect(accepting).rejects.toThrow(InvalidLessonEditError)
    await expect(accepting).rejects.toThrow(key)
    expect(memory.files.size).toBe(0)
    await runLessons(LIST, deps)
    expect(out.join('')).toContain('Validate bodies.')
  })

  it.each([
    ['saved empty', () => '\n   \n', 0],
    ['left with comments only', (shown: string) => shown.replace(/^[^#].*$/gm, ''), 0],
    ['ended by the editor with an error', () => 'rule: Edited.\nscope: [src/**]\n', 1],
  ])('cancels the accept when the file is %s', async (_, rewrite, exitCode) => {
    const { deps, out, err, seed, memory } = harness()
    const id = await seedLesson(seed)
    const { run } = editor(rewrite, exitCode)

    await runLessonsAccept({ id, edit: true }, { ...deps, runInteractive: run })

    expect(err.join('')).toBe(`Accept cancelled; nothing written, lesson ${id} is still pending.\n`)
    expect(memory.files.size).toBe(0)
    await runLessons(LIST, deps)
    expect(out.join('')).toContain('Validate bodies.')
  })

  it('opens vi when neither VISUAL nor EDITOR is set, and refuses an editor not found', async () => {
    const { deps, seed } = harness()
    const id = await seedLesson(seed)
    const commands: string[] = []
    const run: typeof runInteractive = async (command) => {
      commands.push(command)
      return { kind: 'not-found', command }
    }

    await expect(
      runLessonsAccept({ id, edit: true }, { ...deps, runInteractive: run }),
    ).rejects.toThrow(new EditorNotFoundError('vi'))
    expect(commands).toEqual(['vi'])
  })
})

describe('runLessonsDiscard', () => {
  it('drops the lesson from the list and writes no config', async () => {
    const { deps, out, err, seed, memory } = harness()
    const id = await seedLesson(seed)

    await runLessonsDiscard({ id }, deps)

    expect(err.join('')).toBe(`Discarded lesson ${id}; phada lessons no longer lists it.\n`)
    expect(memory.files.size).toBe(0)
    await runLessons(LIST, deps)
    expect(out.join('')).not.toContain('Validate bodies.')
  })
})
