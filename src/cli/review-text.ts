import type { ReviewResult } from '../review/types.js'

const SHORT_SHA_LENGTH = 7

export function modelLabel({ model, additionalModels }: ReviewResult): string {
  if (additionalModels === undefined || additionalModels.length === 0) return model ?? ''
  return `${model} (+ ${additionalModels.join(', ')})`
}

export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH)
}
