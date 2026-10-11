import { posix } from 'node:path'

export class InvalidRepoPathError extends Error {
  override readonly name = 'InvalidRepoPathError'
}

const FORBIDDEN = /[\\\0]/
const DRIVE = /^[A-Za-z]:/

export function toRepoPath(
  input: string | undefined,
  { allowRoot }: { allowRoot: boolean },
): string {
  const raw = (input ?? '').trim()
  const escapes =
    raw.startsWith('/') ||
    raw.startsWith('-') ||
    DRIVE.test(raw) ||
    FORBIDDEN.test(raw) ||
    raw.split('/').includes('..')
  if (escapes) throw new InvalidRepoPathError(`"${raw}" is not a path inside the repository`)
  const normalized = posix.normalize(raw === '' ? '.' : raw).replace(/\/+$/, '')
  const path = normalized === '.' ? '' : normalized
  if (path === '' && !allowRoot) throw new InvalidRepoPathError('give a file path')
  return path
}
