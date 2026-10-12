import { describe, expect, it } from 'vitest'
import { callLines, heritageLines, symbolLines, symbolNamed } from '../../test/support/file-map.js'
import { createExtractor } from './extract.js'

const extractor = createExtractor()

const REPO = `import os, a.b as ab
from .pkg import thing as t, other
from x import *
LIMIT = 3
_private = 1
class Repo(Base, metaclass=Meta):
    cache = {}
    @cached
    def find(self, id, *args, retries: int = 2, **kw):
        return self.db.get(id)
def _helper(x):
    def inner(): return os.path.join(x)
    return inner()
`

async function mapOf(text: string) {
  const map = await extractor.extract('python', text)
  if (map === 'timeout') throw new Error('timeout')
  return map
}

describe('extract Python', () => {
  it('finds the declarations, their owner and whether the name is public', async () => {
    const map = await mapOf(REPO)

    expect(symbolLines(map)).toEqual([
      'variable LIMIT exported',
      'variable _private',
      'class Repo exported',
      'variable cache < Repo exported',
      'method find < Repo exported',
      'parameter self < find',
      'parameter id < find',
      'parameter args < find',
      'parameter retries < find',
      'parameter kw < find',
      'function _helper',
      'parameter x < _helper',
      'function inner < _helper',
    ])
    expect(symbolNamed(map, 'method', 'find')).toMatchObject({
      startLine: 9,
      endLine: 10,
      signature: 'def find(self, id, *args, retries: int = 2, **kw):',
    })
  })

  it('records imports', async () => {
    const map = await mapOf(REPO)

    expect(map.imports).toEqual([
      { module: 'os', name: 'os', kind: 'namespace', line: 1 },
      { module: 'a.b', name: 'ab', kind: 'namespace', line: 1 },
      { module: '.pkg', name: 'thing', alias: 't', kind: 'named', line: 2 },
      { module: '.pkg', name: 'other', kind: 'named', line: 2 },
      { module: 'x', name: '*', kind: 'namespace', line: 3 },
    ])
    expect(map.exports).toEqual([])
  })

  it('records calls and base classes', async () => {
    const map = await mapOf(REPO)

    expect(callLines(map)).toEqual([
      'get on self.db in find',
      'join on os.path in inner',
      'inner in _helper',
    ])
    expect(heritageLines(map)).toEqual(['Repo extends Base'])
  })

  it('reads several names in one assignment and annotated assignments', async () => {
    const map = await mapOf('a, b = 1, 2\nc: int = 3\nif __name__ == "__main__":\n    main()\n')

    expect(symbolLines(map)).toEqual([
      'variable a exported',
      'variable b exported',
      'variable c exported',
    ])
    expect(callLines(map)).toEqual(['main in (module)'])
  })
})
