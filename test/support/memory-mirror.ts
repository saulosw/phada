import { createHash } from 'node:crypto'
import { CheckoutError } from '../../src/repository/checkout.js'
import type { Checkout } from '../../src/repository/checkout.js'
import type { GitMirror, TreeFile } from '../../src/repository/git-mirror.js'

export interface MemoryMirror extends GitMirror {
  fetched: { ref: string; keepAs: string }[]
}

export function memoryCheckout(files: Readonly<Record<string, string>>, commit: string): Checkout {
  return {
    commit,
    readText: async (path) => {
      const text = files[path]
      if (text === undefined) throw new CheckoutError('not-found', `${path} does not exist`)
      return text
    },
    grep: async () => [],
    listDir: async () => [],
    history: async () => ({ commits: [], truncated: false }),
    close: async () => {},
  }
}

export function memoryMirror(
  files: Readonly<Record<string, string>>,
  options: { sha?: string; fetch?: (ref: string) => Promise<void> } = {},
): MemoryMirror {
  const sha = options.sha ?? 'c'.repeat(40)
  const oid = (text: string) => createHash('sha1').update(text).digest('hex')
  const entries: TreeFile[] = Object.entries(files).map(([path, text]) => ({
    path,
    oid: oid(text),
    mode: '100644',
    size: Buffer.byteLength(text),
  }))
  const blobs = new Map(Object.values(files).map((text) => [oid(text), Buffer.from(text)]))
  const fetched: { ref: string; keepAs: string }[] = []
  return {
    dir: '/mirror',
    fetched,
    fetch: async (ref, keepAs) => {
      fetched.push({ ref, keepAs })
      await options.fetch?.(ref)
      return sha
    },
    checkout: () => memoryCheckout(files, sha),
    deepen: async () => false,
    listFiles: async () => entries,
    readBlobs: async function* (wanted) {
      for (const file of wanted) {
        yield { oid: file.oid, bytes: new Uint8Array(blobs.get(file.oid) ?? []) }
      }
    },
  }
}
