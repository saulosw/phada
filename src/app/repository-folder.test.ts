import { describe, expect, it } from 'vitest'
import { readRepositoryFolder } from './repository-folder.js'

function existing(...paths: string[]) {
  const known = new Set(paths)
  return async (path: string) => known.has(path)
}

describe('readRepositoryFolder', () => {
  it('finds the root of the git repository from a folder inside it, without .phada/', async () => {
    expect(await readRepositoryFolder('/w/shop/src/api', existing('/w/shop/.git'))).toEqual({
      kind: 'unconfigured',
      root: '/w/shop',
    })
  })

  it('says the repository already has a .phada/ folder at its root', async () => {
    expect(
      await readRepositoryFolder('/w/shop', existing('/w/shop/.git', '/w/shop/.phada')),
    ).toEqual({ kind: 'configured', root: '/w/shop' })
  })

  it('takes the nearest repository, as a submodule inside another', async () => {
    expect(
      await readRepositoryFolder('/w/shop/lib/x', existing('/w/shop/.git', '/w/shop/lib/.git')),
    ).toEqual({ kind: 'unconfigured', root: '/w/shop/lib' })
  })

  it('says the folder is outside any git repository', async () => {
    expect(await readRepositoryFolder('/tmp/notes', existing())).toEqual({ kind: 'outside' })
  })
})
