import { createInterface } from 'node:readline'
import type { TextOutput } from './progress.js'

export function isTerminalInput(stream: NodeJS.ReadableStream): stream is NodeJS.ReadStream {
  return 'isTTY' in stream && stream.isTTY === true
}

export async function confirm(
  input: NodeJS.ReadableStream,
  output: TextOutput,
  question: string,
): Promise<boolean> {
  output.write(question)
  const lines = createInterface({ input, terminal: false })
  try {
    for await (const line of lines) return /^y(es)?$/i.test(line.trim())
    return false
  } finally {
    lines.close()
  }
}
