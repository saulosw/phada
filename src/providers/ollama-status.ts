import { z } from 'zod'
import { STATUS_TIMEOUT_MS } from './cli-status.js'
import { nodeHttpFetch } from './node-http-fetch.js'
import { resolveOllamaBaseUrl } from './ollama-host.js'
import type { OllamaServer, OllamaStatus, StatusProblem } from './types.js'

const NOT_RUNNING_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])
const OllamaVersion = z.object({ version: z.string() })
const OllamaTags = z.object({ models: z.array(z.object({ name: z.string() })) })

export interface OllamaStatusOptions {
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

type Answer = { kind: 'json'; value: unknown } | { kind: 'stopped' } | { kind: StatusProblem }

export async function checkOllamaStatus(options: OllamaStatusOptions = {}): Promise<OllamaStatus> {
  let baseUrl: string
  try {
    baseUrl = resolveOllamaBaseUrl(options.env ?? process.env)
  } catch {
    return {
      provider: 'ollama',
      baseUrl: null,
      server: { state: 'unknown', problem: 'invalid-host' },
    }
  }
  const fetch = options.fetch ?? nodeHttpFetch
  const signal = AbortSignal.timeout(options.timeoutMs ?? STATUS_TIMEOUT_MS)
  const [version, tags] = await Promise.all([
    getJson(fetch, `${baseUrl}/api/version`, signal),
    getJson(fetch, `${baseUrl}/api/tags`, signal),
  ])
  return { provider: 'ollama', baseUrl, server: serverOf(version, tags) }
}

function serverOf(version: Answer, tags: Answer): OllamaServer {
  if (tags.kind === 'stopped') return { state: 'stopped' }
  if (tags.kind !== 'json') return { state: 'unknown', problem: tags.kind }
  const models = OllamaTags.safeParse(tags.value)
  if (!models.success) return { state: 'unknown', problem: 'unexpected-output' }
  const known = version.kind === 'json' ? OllamaVersion.safeParse(version.value) : undefined
  return {
    state: 'running',
    version: known?.success === true ? known.data.version : null,
    models: models.data.models.map((model) => model.name),
  }
}

async function getJson(
  fetch: typeof globalThis.fetch,
  url: string,
  signal: AbortSignal,
): Promise<Answer> {
  let text: string
  try {
    const response = await fetch(url, { signal })
    text = await response.text()
    if (!response.ok) return { kind: 'failed' }
  } catch (error) {
    return transportAnswer(error)
  }
  try {
    return { kind: 'json', value: JSON.parse(text) as unknown }
  } catch {
    return { kind: 'unexpected-output' }
  }
}

function transportAnswer(error: unknown): Answer {
  if (error instanceof DOMException && error.name === 'TimeoutError') return { kind: 'timeout' }
  const cause = error instanceof Error ? error.cause : undefined
  const code: unknown = cause instanceof Error && 'code' in cause ? cause.code : undefined
  if (typeof code === 'string' && NOT_RUNNING_CODES.has(code)) return { kind: 'stopped' }
  return { kind: 'failed' }
}
