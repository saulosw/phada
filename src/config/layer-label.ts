const USER = 'user:'
const IN_REPOSITORY = /^repos\/[^/]+\/[^/]+\/(.*)$/

export type LayerOrigin =
  | { kind: 'global'; name: string }
  | { kind: 'repository'; name: string }
  | { kind: 'repository-file'; name: string }

export function userLayerLabel(file: string, repo?: { owner: string; repo: string }): string {
  return repo === undefined
    ? `${USER}${file}`
    : `${USER}repos/${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}/${file}`
}

export function layerOrigin(label: string): LayerOrigin {
  if (!label.startsWith(USER)) return { kind: 'repository-file', name: label }
  const name = label.slice(USER.length)
  const inRepository = IN_REPOSITORY.exec(name)
  return inRepository === null
    ? { kind: 'global', name }
    : { kind: 'repository', name: inRepository[1] ?? '' }
}
