import { randomBytes } from 'node:crypto'

export function newNonce(): string {
  return randomBytes(6).toString('hex')
}
