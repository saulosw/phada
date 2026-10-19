import { createHash } from 'node:crypto'

const KEPT_LINE =
  /^(?:diff --git |rename from |rename to |new file mode|deleted file mode|[+-](?!\+\+ |-- ))/

export function diffFingerprint(diff: string): string {
  const kept = diff.split('\n').filter((line) => KEPT_LINE.test(line))
  return createHash('sha256').update(kept.join('\n')).digest('hex').slice(0, 16)
}
