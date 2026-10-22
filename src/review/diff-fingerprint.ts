import { createHash } from 'node:crypto'

const FILE_HEADER = /^(?:diff --git |rename from |rename to |new file mode|deleted file mode)/
const HUNK_HEADER = /^@@ /

export function diffFingerprint(diff: string): string {
  const kept: string[] = []
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (FILE_HEADER.test(line)) {
      inHunk = false
      kept.push(line)
    } else if (HUNK_HEADER.test(line)) {
      inHunk = true
      kept.push('@@')
    } else if (inHunk && /^[ +-]/.test(line)) {
      kept.push(line)
    }
  }
  return createHash('sha256').update(kept.join('\n')).digest('hex').slice(0, 16)
}
