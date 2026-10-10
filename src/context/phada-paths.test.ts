import { describe, expect, it } from 'vitest'
import { phadaDirs, phadaFiles } from './phada-paths.js'

describe('phadaDirs', () => {
  it('lists the root and every folder above the changed files, outer first', () => {
    expect(phadaDirs(['src/api/users.ts', 'src/web/a.ts', 'README.md'])).toEqual([
      '',
      'src',
      'src/api',
      'src/web',
    ])
  })

  it('lists only the root for root files', () => {
    expect(phadaDirs(['README.md'])).toEqual([''])
  })
})

describe('phadaFiles', () => {
  it('names the config and rules files of a folder', () => {
    expect(phadaFiles('')).toEqual({ config: '.phada/config.yml', rules: '.phada/rules.md' })
    expect(phadaFiles('src/api')).toEqual({
      config: 'src/api/.phada/config.yml',
      rules: 'src/api/.phada/rules.md',
    })
  })
})
