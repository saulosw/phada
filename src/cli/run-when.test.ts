import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { WhenInput } from '../app/submit-request.js'
import { whenChecker } from './run-when.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-when-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const INPUT: WhenInput = {
  schemaVersion: 1,
  pullRequest: {
    repo: 'acme/shop',
    number: 7,
    headSha: 'a',
    state: 'open',
    private: false,
    association: 'MEMBER',
    url: 'https://github.com/acme/shop/pull/7',
  },
  request: { source: 'slack', publish: 'pr' },
}
const ENV = { PATH: process.env.PATH }

describe('whenChecker', () => {
  it('lets the request through when the command exits with 0, with the input on stdin', async () => {
    const check = whenChecker({ cwd: dir, env: ENV })
    expect(await check('cat > input.json', INPUT)).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8'))).toEqual(INPUT)
  })

  it('refuses with the first line the command wrote', async () => {
    const check = whenChecker({ cwd: dir, env: ENV })
    expect(await check('echo "only the payments team" >&2; exit 1', INPUT)).toBe(
      'only the payments team',
    )
    expect(await check('exit 2', INPUT)).toBe('it exited with 2')
  })

  it('refuses when the command takes longer than its time', async () => {
    const check = whenChecker({ cwd: dir, env: ENV, timeoutMs: 300 })
    expect(await check('sleep 5', INPUT)).toBe('it did not answer within 0.3s')
  })

  it('refuses when the command cannot run', async () => {
    const check = whenChecker({ cwd: join(dir, 'missing'), env: ENV })
    expect(await check('true', INPUT)).toMatch(/^it could not run: /)
  })
})
