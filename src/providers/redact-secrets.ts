const REDACTED = '[REDACTED]'

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
]

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, REDACTED), text)
}

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) =>
    new RegExp(pattern.source, pattern.flags.replace('g', '')).test(text),
  )
}
