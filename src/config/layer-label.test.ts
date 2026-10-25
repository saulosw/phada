import { describe, expect, it } from 'vitest'
import { layerOrigin, userLayerLabel } from './layer-label.js'

describe('userLayerLabel', () => {
  it('names a file of the user config, at the top or for a repository in lower case', () => {
    expect(userLayerLabel('config.yml')).toBe('user:config.yml')
    expect(userLayerLabel('rules.md', { owner: 'Acme', repo: 'Shop' })).toBe(
      'user:repos/acme/shop/rules.md',
    )
  })
})

describe('layerOrigin', () => {
  it.each([
    ['user:config.yml', { kind: 'global', name: 'config.yml' }],
    ['user:config.yml#2', { kind: 'global', name: 'config.yml#2' }],
    ['user:repos/acme/shop/rules.md', { kind: 'repository', name: 'rules.md' }],
    ['user:repos/acme/shop/config.yml#1', { kind: 'repository', name: 'config.yml#1' }],
    ['.phada/config.yml', { kind: 'repository-file', name: '.phada/config.yml' }],
    ['api/.phada/rules.md', { kind: 'repository-file', name: 'api/.phada/rules.md' }],
  ])('reads %s as %j', (label, origin) => {
    expect(layerOrigin(label)).toEqual(origin)
  })

  it('reads back every label it builds', () => {
    expect(layerOrigin(userLayerLabel('config.yml'))).toEqual({
      kind: 'global',
      name: 'config.yml',
    })
    expect(layerOrigin(userLayerLabel('config.yml', { owner: 'a', repo: 'b' }))).toEqual({
      kind: 'repository',
      name: 'config.yml',
    })
  })
})
