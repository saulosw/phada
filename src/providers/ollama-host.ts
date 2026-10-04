import { isIPv6 } from 'node:net'
import { ProviderError } from './types.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'
const DEFAULT_PORT = '11434'
const LOOPBACK = '127.0.0.1'
const BIND_ALL: ReadonlySet<string> = new Set(['0.0.0.0', '[::]'])
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const HAS_PORT = /:\d+$/

export function resolveOllamaBaseUrl(env: NodeJS.ProcessEnv): string {
  const host = env.OLLAMA_HOST?.trim() ?? ''
  if (host === '') return DEFAULT_BASE_URL
  const url = HAS_SCHEME.test(host) ? parseUrl(host, host) : parseSchemeless(host)
  if (BIND_ALL.has(url.hostname)) url.hostname = LOOPBACK
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

function parseSchemeless(host: string): URL {
  const slash = host.indexOf('/')
  const authority = normalizeAuthority(slash === -1 ? host : host.slice(0, slash))
  const url = parseUrl(`http://${authority}${slash === -1 ? '' : host.slice(slash)}`, host)
  if (!HAS_PORT.test(authority)) url.port = DEFAULT_PORT
  return url
}

function normalizeAuthority(authority: string): string {
  if (isIPv6(authority)) return `[${authority}]`
  if (authority.startsWith(':')) return `${LOOPBACK}${authority}`
  return authority
}

function parseUrl(candidate: string, host: string): URL {
  try {
    return new URL(candidate)
  } catch (error) {
    throw new ProviderError('ollama', 'failed', `OLLAMA_HOST "${host}" is not a valid address.`, {
      cause: error,
    })
  }
}
