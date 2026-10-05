export type JsonSchema = Readonly<Record<string, unknown>>

export interface ReviewPrompt {
  instructions: string
  data: string
  outputSchema: JsonSchema
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface ReviewOutput {
  text: string
  durationMs: number
  model?: string
  additionalModels?: string[]
  usage?: TokenUsage
}

export interface ReviewProvider {
  readonly id: string
  review(prompt: ReviewPrompt): Promise<ReviewOutput>
}

export type ProviderErrorReason =
  | 'not-installed'
  | 'not-authenticated'
  | 'timeout'
  | 'failed'
  | 'invalid-output'
  | 'prompt-too-large'

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
