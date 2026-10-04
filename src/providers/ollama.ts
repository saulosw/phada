import { z } from 'zod'
import { nodeHttpFetch } from './node-http-fetch.js'
import { resolveOllamaBaseUrl } from './ollama-host.js'
import { redactSecrets } from './redact-secrets.js'
import { ProviderError } from './types.js'
import type { ReviewOutput, ReviewPrompt, ReviewProvider, TokenUsage } from './types.js'

const PROVIDER_ID = 'ollama'
const DEFAULT_TIMEOUT_MS = 1_800_000
const ASCII_CHARS_PER_TOKEN = 2
const TOKENS_PER_OTHER_CHAR = 2
const MAX_ASCII = 0x7f
const MAX_CHARS_PER_TOKEN = 6
const OUTPUT_RESERVE = 8192
const CONTEXT_STEP = 1024
const MAX_DETAIL_LENGTH = 300
const INSTALL_URL = 'https://ollama.com/download'
const NOT_RUNNING_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])
const CLIENT_TIMEOUT_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

const OllamaShow = z.object({ model_info: z.record(z.string(), z.unknown()).optional() })
const OllamaChat = z.object({
  model: z.string(),
  message: z.object({ content: z.string() }),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
})
type OllamaChat = z.infer<typeof OllamaChat>
const OllamaErrorBody = z.object({ error: z.string() })

export interface OllamaProviderOptions {
  model: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export class OllamaProvider implements ReviewProvider {
  readonly id = PROVIDER_ID
  readonly #model: string
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch
  readonly #timeoutMs: number

  constructor(options: OllamaProviderOptions) {
    this.#model = options.model
    this.#baseUrl = resolveOllamaBaseUrl(options.env ?? process.env)
    this.#fetch = options.fetch ?? nodeHttpFetch
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async review(prompt: ReviewPrompt): Promise<ReviewOutput> {
    const startedAt = performance.now()
    const signal = AbortSignal.timeout(this.#timeoutMs)
    const show = OllamaShow.safeParse(await this.#post(signal, '/api/show', { model: this.#model }))
    const contextLength = contextLengthOf(show.success ? show.data.model_info : undefined)
    if (contextLength === undefined) {
      throw new ProviderError(
        PROVIDER_ID,
        'failed',
        `Could not read the context window of "${this.#model}" from Ollama.`,
      )
    }
    const promptChars = prompt.instructions.length + prompt.data.length
    const needed = estimateTokens(prompt.instructions + prompt.data) + OUTPUT_RESERVE
    if (needed > contextLength) {
      throw new ProviderError(
        PROVIDER_ID,
        'prompt-too-large',
        `The review needs about ${needed} tokens but ${this.#model} holds ${contextLength}. Use a model with a larger context window (see "ollama show ${this.#model}") or a :cloud model.`,
      )
    }

    const numCtx = Math.min(contextLength, roundUp(needed, CONTEXT_STEP))
    const chat = OllamaChat.safeParse(
      await this.#post(signal, '/api/chat', {
        model: this.#model,
        stream: false,
        messages: [
          { role: 'system', content: prompt.instructions },
          { role: 'user', content: prompt.data },
        ],
        options: {
          num_ctx: numCtx,
          num_predict: OUTPUT_RESERVE,
        },
      }),
    )
    if (!chat.success) {
      throw new ProviderError(
        PROVIDER_ID,
        'invalid-output',
        'Ollama returned an unexpected response.',
      )
    }
    assertComplete(chat.data, promptChars, numCtx)
    return toReviewOutput(chat.data, performance.now() - startedAt)
  }

  async #post(signal: AbortSignal, path: string, body: unknown): Promise<unknown> {
    let response: Response
    let text: string
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      text = await response.text()
    } catch (error) {
      throw this.#transportError(error)
    }
    if (!response.ok) throw this.#statusError(response.status, text)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new ProviderError(
        PROVIDER_ID,
        'invalid-output',
        `Ollama returned an unexpected response: ${detail(text)}`,
      )
    }
  }

  #transportError(error: unknown): ProviderError {
    const code = errorCode(error)
    if (isTimeout(error) || (code !== undefined && CLIENT_TIMEOUT_CODES.has(code))) {
      return new ProviderError(
        PROVIDER_ID,
        'timeout',
        `Ollama did not answer within ${this.#timeoutMs / 1000}s.`,
        { cause: error },
      )
    }
    if (code !== undefined && NOT_RUNNING_CODES.has(code)) {
      return new ProviderError(
        PROVIDER_ID,
        'failed',
        `Ollama is not running at ${this.#baseUrl}. Start it with "ollama serve" or install it from ${INSTALL_URL}.`,
        { cause: error },
      )
    }
    return new ProviderError(
      PROVIDER_ID,
      'failed',
      `Could not reach Ollama at ${this.#baseUrl} (${detail(code ?? errorName(error))}).`,
      { cause: error },
    )
  }

  #statusError(status: number, text: string): ProviderError {
    const parsed = OllamaErrorBody.safeParse(parseJson(text))
    const message = detail(parsed.success ? parsed.data.error : text)
    if (status === 404) {
      return new ProviderError(
        PROVIDER_ID,
        'failed',
        `Model "${this.#model}" is not available in Ollama. Run "ollama pull ${this.#model}".`,
      )
    }
    if (status === 401 || status === 403) {
      return new ProviderError(
        PROVIDER_ID,
        'not-authenticated',
        `Ollama refused the request for "${this.#model}": ${message}`,
      )
    }
    return new ProviderError(
      PROVIDER_ID,
      'failed',
      message === ''
        ? `Ollama returned HTTP ${status}.`
        : `Ollama returned HTTP ${status}: ${message}`,
    )
  }
}

function contextLengthOf(info: Record<string, unknown> | undefined): number | undefined {
  if (info === undefined) return undefined
  const architecture = info['general.architecture']
  const preferred =
    typeof architecture === 'string' ? info[`${architecture}.context_length`] : undefined
  if (isPositiveInteger(preferred)) return preferred
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && isPositiveInteger(value)) return value
  }
  return undefined
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError'
}

function errorCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined
  const code: unknown = cause instanceof Error && 'code' in cause ? cause.code : undefined
  return typeof code === 'string' ? code : undefined
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function estimateTokens(text: string): number {
  let asciiChars = 0
  let otherChars = 0
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) <= MAX_ASCII) asciiChars += 1
    else otherChars += 1
  }
  return Math.ceil(asciiChars / ASCII_CHARS_PER_TOKEN) + otherChars * TOKENS_PER_OTHER_CHAR
}

function assertComplete(chat: OllamaChat, promptChars: number, numCtx: number): void {
  const minimumTokens = Math.ceil(promptChars / MAX_CHARS_PER_TOKEN)
  if (chat.prompt_eval_count !== undefined && chat.prompt_eval_count < minimumTokens) {
    throw new ProviderError(
      PROVIDER_ID,
      'invalid-output',
      `Ollama truncated the prompt (read ${chat.prompt_eval_count} tokens, expected at least ${minimumTokens}).`,
    )
  }
  if (chat.prompt_eval_count !== undefined && chat.eval_count !== undefined) {
    const used = chat.prompt_eval_count + chat.eval_count
    if (used >= numCtx) {
      throw new ProviderError(
        PROVIDER_ID,
        'invalid-output',
        `Ollama ran out of context window (used ${used} of ${numCtx} tokens).`,
      )
    }
  }
  if (chat.done_reason === 'length') {
    throw new ProviderError(
      PROVIDER_ID,
      'invalid-output',
      `Ollama stopped the review at the ${OUTPUT_RESERVE}-token output limit.`,
    )
  }
  if (chat.message.content.trim() === '') {
    throw new ProviderError(PROVIDER_ID, 'invalid-output', 'Ollama returned an empty review.')
  }
}

function toReviewOutput(chat: OllamaChat, durationMs: number): ReviewOutput {
  const usage = toTokenUsage(chat)
  return {
    text: chat.message.content,
    durationMs,
    model: chat.model,
    ...(usage === undefined ? {} : { usage }),
  }
}

function toTokenUsage(chat: OllamaChat): TokenUsage | undefined {
  if (chat.prompt_eval_count === undefined && chat.eval_count === undefined) return undefined
  return { inputTokens: chat.prompt_eval_count ?? 0, outputTokens: chat.eval_count ?? 0 }
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function detail(text: string): string {
  return redactSecrets(text).trim().slice(0, MAX_DETAIL_LENGTH)
}
