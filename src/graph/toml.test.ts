import { describe, expect, it } from 'vitest'
import { parseTomlTables } from './toml.js'

describe('parseTomlTables', () => {
  it('reads strings and string arrays by table, across lines, without comments', () => {
    const tables = parseTomlTables(
      [
        'name = "top"',
        '[project]',
        "name = 'My_Lib' # the name",
        'dependencies = [',
        '  "requests>=2",  # http',
        '  \'acme-core[extra]; python_version>"3.8"\',',
        ']',
        'version = 3',
        '[tool.poetry.dependencies]',
        'python = "^3.11"',
        'acme-core = { version = "^1" }',
      ].join('\n'),
    )

    expect(tables.get('')?.get('name')).toBe('top')
    expect(tables.get('project')?.get('name')).toBe('My_Lib')
    expect(tables.get('project')?.get('dependencies')).toEqual([
      'requests>=2',
      'acme-core[extra]; python_version>"3.8"',
    ])
    expect([...(tables.get('tool.poetry.dependencies')?.keys() ?? [])]).toEqual([
      'python',
      'acme-core',
    ])
  })

  it('returns what it read before broken text', () => {
    expect(
      parseTomlTables('[project]\nname = "a"\ndependencies = ["x"').get('project')?.get('name'),
    ).toBe('a')
  })
})
