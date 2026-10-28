import type { UserRepository } from '../github/user-repositories.js'
import { errorMessage } from './error-message.js'

export interface UserRepositoryReaders {
  token(): Promise<string | undefined>
  listRepositories(token: string): Promise<UserRepository[]>
  watchedRepos(): Promise<string[]>
}

export type PickableRepository =
  | (UserRepository & { watched: boolean; listed: true })
  | { name: string; watched: true; listed: false }

export type UserRepositories =
  | { status: 'listed'; repositories: PickableRepository[] }
  | { status: 'no-token'; repositories: PickableRepository[] }
  | { status: 'failed'; error: string; repositories: PickableRepository[] }

export async function readUserRepositories(
  readers: UserRepositoryReaders,
): Promise<UserRepositories> {
  const watched = await readers.watchedRepos()
  const token = await readers.token()
  if (token === undefined) return { status: 'no-token', repositories: pickable([], watched) }
  try {
    const listed = await readers.listRepositories(token)
    return { status: 'listed', repositories: pickable(listed, watched) }
  } catch (error) {
    return { status: 'failed', error: errorMessage(error), repositories: pickable([], watched) }
  }
}

function pickable(
  listed: readonly UserRepository[],
  watchedRepos: readonly string[],
): PickableRepository[] {
  const watched = new Set(watchedRepos.map(keyOf))
  const listedKeys = new Set(listed.map(({ name }) => keyOf(name)))
  const rows = listed.map((repository) => ({
    ...repository,
    watched: watched.has(keyOf(repository.name)),
    listed: true as const,
  }))
  const unlisted = watchedRepos
    .filter((name) => !listedKeys.has(keyOf(name)))
    .map((name) => ({ name, watched: true as const, listed: false as const }))
  return [...rows.filter((row) => row.watched), ...unlisted, ...rows.filter((row) => !row.watched)]
}

function keyOf(name: string): string {
  return name.trim().toLowerCase()
}
