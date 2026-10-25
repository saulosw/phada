import { describe, expect, it } from 'vitest'
import { joinNames, nameList } from './name-list.js'

describe('nameList', () => {
  it('lists the first five names and counts the rest', () => {
    expect(nameList(['a', 'b'])).toBe('a, b')
    expect(nameList(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a, b, c, d, e, 2 more')
    expect(nameList(['a', 'b'], (name) => name.toUpperCase())).toBe('A, B')
  })

  it('counts the rest in the words it is given', () => {
    expect(joinNames(['a'], 3, (count) => `${count} a mais`)).toBe('a, 2 a mais')
  })
})
