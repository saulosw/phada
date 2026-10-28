import { describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { applyUserConfigPlan, planUserConfig } from './edit-user-config.js'
import type { UserConfigFiles } from './edit-user-config.js'

const ENV = { PHADA_CONFIG_HOME: '/cfg' }
const HOME = '/home/u'
const PATH = '/cfg/config.yml'
const TEMPLATE = '# Your own Phada config.\n'

function request(changes: Parameters<typeof planUserConfig>[0]['changes']) {
  return { env: ENV, home: HOME, template: TEMPLATE, changes }
}

async function plannedWith(files: UserConfigFiles, changes: Parameters<typeof request>[0]) {
  const result = await planUserConfig(request(changes), files)
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`)
  return result.plan
}

describe('planUserConfig', () => {
  it("plans the change on the user's own config.yml", async () => {
    const files = memoryFiles({ [PATH]: 'provider: claude # mine\n' })

    const plan = await plannedWith(files, [{ kind: 'set', key: 'provider', value: 'codex' }])

    expect(plan).toEqual({
      path: PATH,
      exists: true,
      before: 'provider: claude # mine\n',
      text: 'provider: codex # mine\n',
      changes: [{ key: 'provider', before: 'claude', after: 'codex' }],
    })
  })

  it('reports a config it cannot read', async () => {
    const files: UserConfigFiles = {
      readText: async () => {
        throw new Error('EACCES: permission denied')
      },
      writeAtomic: async () => undefined,
    }

    expect(await planUserConfig(request([]), files)).toEqual({
      ok: false,
      reason: 'unreadable',
      message: 'EACCES: permission denied',
    })
  })
})

describe('applyUserConfigPlan', () => {
  it('writes the planned text, creating the folder', async () => {
    const files = memoryFiles()
    const plan = await plannedWith(files, [{ kind: 'set', key: 'language', value: 'pt-BR' }])

    expect(await applyUserConfigPlan(plan, files)).toEqual({ ok: true, written: true })
    expect(files.files.get(PATH)).toBe(`language: pt-BR\n\n${TEMPLATE}`)
  })

  it('writes nothing when the plan changes nothing', async () => {
    const files = memoryFiles()
    const plan = await plannedWith(files, [{ kind: 'unset', key: 'model' }])

    expect(await applyUserConfigPlan(plan, files)).toEqual({ ok: true, written: false })
    expect(files.files.has(PATH)).toBe(false)
  })

  it('refuses to write over a file changed since the plan', async () => {
    const files = memoryFiles({ [PATH]: 'provider: claude\n' })
    const plan = await plannedWith(files, [{ kind: 'set', key: 'provider', value: 'codex' }])
    files.files.set(PATH, 'provider: claude\nlanguage: es\n')

    expect(await applyUserConfigPlan(plan, files)).toEqual({ ok: false, reason: 'changed' })
    expect(files.files.get(PATH)).toBe('provider: claude\nlanguage: es\n')
  })

  it('reports a failed write', async () => {
    const files = memoryFiles()
    const plan = await plannedWith(files, [{ kind: 'set', key: 'language', value: 'es' }])
    const failing: UserConfigFiles = {
      readText: files.readText,
      writeAtomic: async () => {
        throw new Error('EACCES: permission denied')
      },
    }

    expect(await applyUserConfigPlan(plan, failing)).toEqual({
      ok: false,
      reason: 'failed',
      message: 'EACCES: permission denied',
    })
  })
})
