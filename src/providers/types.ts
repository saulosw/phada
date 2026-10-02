export interface ReviewOutput {
  text: string
  durationMs: number
  model?: string
}

export interface ReviewProvider {
  readonly id: string
  review(prompt: string): Promise<ReviewOutput>
}

export type ProviderErrorReason =
  'not-installed' | 'not-authenticated' | 'timeout' | 'failed' | 'invalid-output'

export class ProviderError extends Error {
  override readonly name = 'ProviderError'
  readonly providerId: string
  readonly reason: ProviderErrorReason

  constructor(
    providerId: string,
    reason: ProviderErrorReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.providerId = providerId
    this.reason = reason
  }
}
