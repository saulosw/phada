import {
  GitHubAuthError,
  GitHubGraphQLError,
  GitHubRateLimitError,
  GitHubRequestError,
} from '../github/errors.js'
import { ProviderError } from '../providers/types.js'
import { MirrorLockTimeoutError } from '../repository/mirror-lock.js'
import type { Failure } from '../app/watch-repositories.js'
import type { FailureKind } from '../store/history-store.js'

const PROVIDER_KINDS: Readonly<Record<ProviderError['reason'], FailureKind>> = {
  'usage-limit': 'usage-limit',
  timeout: 'transient',
  failed: 'transient',
  'invalid-output': 'definitive',
  'prompt-too-large': 'definitive',
  'not-installed': 'fatal',
  'not-authenticated': 'fatal',
}

export function classifyFailure(error: unknown, now = new Date()): Failure {
  if (error instanceof ProviderError) return { kind: PROVIDER_KINDS[error.reason] }
  if (error instanceof GitHubRateLimitError) {
    const resetAt =
      error.resetAt ??
      (error.retryAfterSeconds === undefined
        ? undefined
        : new Date(now.getTime() + error.retryAfterSeconds * 1000))
    return {
      kind: 'rate-limit',
      ...(resetAt === undefined ? {} : { resetAt: resetAt.toISOString() }),
    }
  }
  if (error instanceof GitHubAuthError)
    return { kind: error.status === 401 ? 'fatal' : 'definitive' }
  if (error instanceof GitHubRequestError) {
    return { kind: error.status === undefined || error.status >= 500 ? 'transient' : 'definitive' }
  }
  if (error instanceof GitHubGraphQLError || error instanceof MirrorLockTimeoutError) {
    return { kind: 'transient' }
  }
  if (error instanceof TypeError && /fetch failed/i.test(error.message))
    return { kind: 'transient' }
  return { kind: 'definitive' }
}
