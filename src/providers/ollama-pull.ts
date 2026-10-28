import { z } from 'zod'
import { nodeHttpFetch } from './node-http-fetch.js'
import { resolveOllamaBaseUrl } from './ollama-host.js'
import type { OllamaPullProgress, OllamaPullResult } from './types.js'

const NOT_RUNNING_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])
const SUCCESS = 'success'
const PullLine = z.union([
  z.object({ error: z.string() }),
  z.object({
    status: z.string(),
    completed: z.number().optional(),
    total: z.number().optional(),
  }),
])
const ErrorBody = z.object({ error: z.string() })

export interface OllamaPullOptions {
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
  onProgress?: (progress: OllamaPullProgress) => void
}

export async function pullOllamaModel(
  model: string,
  options: OllamaPullOptions = {},
): Promise<OllamaPullResult> {
  let baseUrl: string
  try {
    baseUrl = resolveOllamaBaseUrl(options.env ?? process.env)
  } catch (error) {
    return failedWith(error)
  }
  const { signal } = options
  const fetch = options.fetch ?? nodeHttpFetch
  try {
    const response = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok)
      return { kind: 'failed', message: statusMessage(response.status, await response.text()) }
    return await readPull(response, options)
  } catch (error) {
    if (signal?.aborted === true) return { kind: 'cancelled' }
    if (NOT_RUNNING_CODES.has(errorCode(error) ?? '')) return { kind: 'stopped' }
    return failedWith(error)
  }
}

async function readPull(
  response: Response,
  { signal, onProgress }: OllamaPullOptions,
): Promise<OllamaPullResult> {
  const reader = response.body?.getReader()
  if (reader === undefined) return { kind: 'failed', message: null }
  const decoder = new TextDecoder()
  const stop = () => void reader.cancel().catch(() => undefined)
  const aborted = () => signal?.aborted === true
  signal?.addEventListener('abort', stop, { once: true })
  try {
    let pending = ''
    for (;;) {
      const chunk = await reader.read()
      if (aborted()) return { kind: 'cancelled' }
      const text = chunk.done
        ? `${pending}${decoder.decode()}\n`
        : pending + decoder.decode(chunk.value, { stream: true })
      const parts = text.split('\n')
      pending = parts.pop() ?? ''
      for (const part of parts) {
        const outcome = readLine(part, onProgress)
        if (outcome !== undefined) return outcome
        if (aborted()) return { kind: 'cancelled' }
      }
      if (chunk.done) return { kind: 'failed', message: null }
    }
  } finally {
    signal?.removeEventListener('abort', stop)
    stop()
  }
}

function readLine(
  text: string,
  onProgress: OllamaPullOptions['onProgress'],
): OllamaPullResult | undefined {
  if (text.trim() === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const line = PullLine.safeParse(value)
  if (!line.success) return undefined
  if ('error' in line.data) return { kind: 'failed', message: line.data.error }
  const { status, completed, total } = line.data
  onProgress?.({ status, completed: completed ?? null, total: total ?? null })
  return status === SUCCESS ? { kind: 'pulled' } : undefined
}

function statusMessage(status: number, body: string): string {
  const parsed = ErrorBody.safeParse(jsonOf(body))
  return parsed.success ? parsed.data.error : `HTTP ${status}`
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function failedWith(error: unknown): OllamaPullResult {
  return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
}

function errorCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined
  const code: unknown = cause instanceof Error && 'code' in cause ? cause.code : undefined
  return typeof code === 'string' ? code : undefined
}
