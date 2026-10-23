import { describe, expect, it } from 'vitest'
import { applyJq } from './gh-jq.js'
import { GhFacadeError } from './types.js'

const value = { title: 'Spend', files: [{ path: 'a.ts' }, { path: 'b.ts' }], a: { b: 1 } }

describe('applyJq', () => {
  it.each([
    ['.title', ['Spend']],
    ['.files[].path', ['a.ts', 'b.ts']],
    ['.files[0].path', ['a.ts']],
    ['.a.b', ['1']],
    ['.a', ['{"b":1}']],
    ['.', [JSON.stringify(value)]],
    ['.missing', ['null']],
  ])('applies %s', (expression, expected) => {
    expect(applyJq(value, expression)).toEqual(expected)
  })

  it('refuses anything that is not a path', () => {
    expect(() => applyJq(value, '.files | map(select(.x))')).toThrow(
      new GhFacadeError(
        'phada: --jq supports only paths like .files[].path during a review; use --json and read the output.',
      ),
    )
  })
})
