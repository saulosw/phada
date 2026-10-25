const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface CutCount {
  truncated: number
}

export function byteLength(text: string): number {
  return encoder.encode(text).length
}

export function cutBytes(text: string, maxBytes: number, cuts: CutCount): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  cuts.truncated++
  const kept = decoder.decode(bytes.slice(0, maxBytes)).replace(/�$/, '')
  return `${kept}\n[truncated by Phada: ${byteLength(kept)} of ${bytes.length} bytes]`
}
