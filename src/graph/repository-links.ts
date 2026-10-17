import { packageKey } from './packages.js'
import type { PackageRef, RepositoryPackages } from './packages.js'

export interface RepositoryLink {
  consumedByRelated: PackageRef[]
  consumedByReviewed: PackageRef[]
}

export function linkRepositories(
  reviewed: RepositoryPackages,
  related: RepositoryPackages,
): RepositoryLink {
  return {
    consumedByRelated: shared(reviewed.published, related.depends),
    consumedByReviewed: shared(related.published, reviewed.depends),
  }
}

export function hasLink(link: RepositoryLink): boolean {
  return link.consumedByRelated.length > 0 || link.consumedByReviewed.length > 0
}

function shared(published: readonly PackageRef[], depends: readonly PackageRef[]): PackageRef[] {
  const wanted = new Set(depends.map(packageKey))
  return published.filter((item) => wanted.has(packageKey(item)))
}
