export type CheckoutErrorReason =
  | 'not-found'
  | 'directory'
  | 'not-directory'
  | 'symlink'
  | 'submodule'
  | 'binary'
  | 'too-large'
  | 'invalid-pattern'
  | 'too-many-matches'
  | 'failed'

export class CheckoutError extends Error {
  override readonly name = 'CheckoutError'
  readonly reason: CheckoutErrorReason

  constructor(reason: CheckoutErrorReason, message: string) {
    super(message)
    this.reason = reason
  }
}

export interface GrepMatch {
  path: string
  line: number
  text: string
}

export interface GrepOptions {
  path?: string
  ignoreCase?: boolean
}

export type DirEntryKind = 'file' | 'dir' | 'symlink' | 'submodule'

export interface DirEntry {
  name: string
  kind: DirEntryKind
}

export interface Checkout {
  readonly commit: string
  readText(path: string): Promise<string>
  grep(pattern: string, options: GrepOptions): Promise<GrepMatch[]>
  listDir(path: string): Promise<DirEntry[]>
  close(): Promise<void>
}
