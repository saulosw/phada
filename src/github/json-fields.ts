import { GitHubRequestError } from './errors.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function field(root: unknown, path: string): unknown {
  let value = root
  for (const key of path.split('.')) {
    value = isRecord(value) ? value[key] : undefined
  }
  return value
}

export function stringField(root: unknown, path: string): string {
  const value = field(root, path)
  if (typeof value !== 'string') throw invalidPayload(path)
  return value
}

export function nullableStringField(root: unknown, path: string): string | null {
  const value = field(root, path)
  if (value === null) return null
  if (typeof value !== 'string') throw invalidPayload(path)
  return value
}

export function numberField(root: unknown, path: string): number {
  const value = field(root, path)
  if (typeof value !== 'number') throw invalidPayload(path)
  return value
}

export function nullableNumberField(root: unknown, path: string): number | null {
  const value = field(root, path)
  if (value === null) return null
  if (typeof value !== 'number') throw invalidPayload(path)
  return value
}

export function booleanField(root: unknown, path: string): boolean {
  const value = field(root, path)
  if (typeof value !== 'boolean') throw invalidPayload(path)
  return value
}

export function arrayField(root: unknown, path: string): unknown[] {
  const value = field(root, path)
  if (!Array.isArray(value)) throw invalidPayload(path)
  return value
}

export function invalidPayload(path: string): GitHubRequestError {
  return new GitHubRequestError(`Unexpected GitHub response: missing or invalid "${path}"`)
}
