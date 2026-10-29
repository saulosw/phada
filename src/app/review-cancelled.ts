export class ReviewCancelledError extends Error {
  constructor(options?: ErrorOptions) {
    super('The review was cancelled.', options)
    this.name = 'ReviewCancelledError'
  }
}

export function stopIfCancelled(signal: AbortSignal | undefined, cause?: unknown): void {
  if (signal?.aborted !== true) return
  throw cause instanceof ReviewCancelledError
    ? cause
    : new ReviewCancelledError(cause === undefined ? undefined : { cause })
}
