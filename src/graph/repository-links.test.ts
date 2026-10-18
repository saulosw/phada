import { describe, expect, it } from 'vitest'
import type { RepositoryPackages } from './packages.js'
import { hasLink, linkRepositories } from './repository-links.js'

const npm = (name: string) => ({ ecosystem: 'npm' as const, name })
const python = (name: string) => ({ ecosystem: 'python' as const, name })
const packages = (
  published: RepositoryPackages['published'],
  depends: RepositoryPackages['depends'] = [],
) => ({
  published,
  depends,
})

describe('linkRepositories', () => {
  it('links a related repository that depends on a package of the reviewed one', () => {
    const link = linkRepositories(packages([npm('@acme/core')]), packages([], [npm('@acme/core')]))

    expect(link).toEqual({ consumedByRelated: [npm('@acme/core')], consumedByReviewed: [] })
    expect(hasLink(link)).toBe(true)
  })

  it('links the reviewed repository to the packages it uses from the related one', () => {
    const link = linkRepositories(packages([], [python('acme-db')]), packages([python('acme-db')]))

    expect(link).toEqual({ consumedByRelated: [], consumedByReviewed: [python('acme-db')] })
  })

  it('never links the same name across ecosystems', () => {
    const link = linkRepositories(packages([npm('acme')]), packages([], [python('acme')]))

    expect(hasLink(link)).toBe(false)
  })
})
