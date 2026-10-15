import { describe, expect, it } from 'vitest'
import {
  callLines,
  heritageLines,
  referenceLines,
  symbolLines,
  symbolNamed,
} from '../../test/support/file-map.js'
import { createExtractor } from './extract.js'

const extractor = createExtractor()

const STORE = `package store
import (
  "fmt"
  db "example.com/db"
)
const Max = 3
var cache = map[string]int{}
type Reader interface { io.Reader; Read(id string) error }
func (s *Store) Load(id string) error { fmt.Println(id); return db.Get(id) }
type Store struct { Base; name string }
type ID string
func New() *Store { return &Store{} }
func (c *Cache[K]) Put(k K, v, w int) {}
`

async function mapOf(text: string) {
  const map = await extractor.extract('go', text)
  if (map === 'timeout') throw new Error('timeout')
  return map
}

describe('extract Go', () => {
  it('finds the declarations and ties methods to their struct', async () => {
    const map = await mapOf(STORE)

    expect(symbolLines(map)).toEqual([
      'variable Max exported',
      'variable cache',
      'interface Reader exported',
      'method Read < Reader exported',
      'parameter id < Read',
      'method Load < Store exported',
      'parameter s < Load',
      'parameter id < Load',
      'struct Store exported',
      'type ID exported',
      'function New exported',
      'method Put < (Cache) exported',
      'parameter c < Put',
      'parameter k < Put',
      'parameter v < Put',
      'parameter w < Put',
    ])
    expect(symbolNamed(map, 'method', 'Load')?.signature).toBe(
      'func (s *Store) Load(id string) error',
    )
  })

  it('records imports by path with the name they are used by', async () => {
    const map = await mapOf(STORE)

    expect(map.imports).toEqual([
      { module: 'fmt', name: 'fmt', kind: 'namespace', line: 3 },
      { module: 'example.com/db', name: 'db', kind: 'namespace', line: 4 },
    ])
  })

  it('records calls and embedded types', async () => {
    const map = await mapOf(STORE)

    expect(callLines(map)).toEqual(['Println on fmt in Load', 'Get on db in Load'])
    expect(heritageLines(map)).toEqual(['Reader embeds io.Reader', 'Store embeds Base'])
  })

  it('reads a single import and a variadic parameter', async () => {
    const map = await mapOf('package main\nimport . "strings"\nfunc Join(parts ...string) {}\n')

    expect(map.imports).toEqual([{ module: 'strings', name: '.', kind: 'namespace', line: 2 }])
    expect(symbolLines(map)).toEqual(['function Join exported', 'parameter parts < Join'])
  })

  it('records uses of imported packages that are not calls', async () => {
    const map = await mapOf(`package app
import "example.com/m/store"
var s store.Store
func f() {
  x := store.Default
  store.Open(x)
}
`)

    expect(referenceLines(map)).toEqual(['Store on store in (module):3', 'Default on store in f:5'])
  })
})
