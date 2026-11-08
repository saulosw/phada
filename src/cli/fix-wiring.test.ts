import { describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { UsageError } from './errors.js'
import { pickNumbers, workingFiles } from './fix-wiring.js'

describe('workingFiles', () => {
  it('reads and writes the files under the root', async () => {
    const disk = memoryFiles({ '/repo/src/a.ts': 'one\n' })
    const files = workingFiles('/repo', disk)

    expect(await files.read('src/a.ts')).toBe('one\n')
    expect(await files.read('src/missing.ts')).toBeUndefined()
    await files.write('src/b.ts', 'two\n')
    expect(disk.files.get('/repo/src/b.ts')).toBe('two\n')
  })

  it.each([['../outside.ts'], ['src/../../outside.ts'], ['/outside.ts'], ['.'], ['']])(
    'ignores %j, which is not a file under the root',
    async (path) => {
      const disk = memoryFiles({ '/outside.ts': 'secret\n', '/repo': 'root\n' })
      const files = workingFiles('/repo', disk)

      expect(await files.read(path)).toBeUndefined()
      await files.write(path, 'changed\n')
      expect(disk.files.get('/outside.ts')).toBe('secret\n')
      expect(disk.files.get('/repo')).toBe('root\n')
      expect([...disk.files.keys()].sort()).toEqual(['/outside.ts', '/repo'])
    },
  )

  it('ignores a sibling folder whose name starts with the root', async () => {
    const disk = memoryFiles({ '/repo-other/a.ts': 'other\n' })

    expect(await workingFiles('/repo', disk).read('../repo-other/a.ts')).toBeUndefined()
  })
})

describe('pickNumbers', () => {
  const items = [{ number: 1 }, { number: 2 }, { number: 3 }]
  const unknown = (number: number, last: number) => `No ${number}; last is ${last}.`

  it('picks every item when no number is given', () => {
    const picked = pickNumbers(items, undefined, unknown)

    expect(picked).toEqual(items)
    expect(picked).not.toBe(items)
  })

  it('picks the given numbers in the order of the items', () => {
    expect(pickNumbers(items, [3, 1], unknown)).toEqual([{ number: 1 }, { number: 3 }])
  })

  it('refuses the first number past the last item with a usage error', () => {
    expect(() => pickNumbers(items, [2, 5, 4], unknown)).toThrow(UsageError)
    expect(() => pickNumbers(items, [2, 5, 4], unknown)).toThrow('No 5; last is 3.')
  })
})
