export const CI_LOG_JOB_BYTES = 8 * 1024

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
const STEP = '##[group]Run '
const ERROR = '##[error]'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function failedStepLog(
  log: string,
  maxBytes: number = CI_LOG_JOB_BYTES,
  { partial = false }: { partial?: boolean } = {},
): string {
  const lines = log
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .slice(partial ? 1 : 0)
    .map((line) => line.replace(TIMESTAMP, '').replace(ANSI, ''))
  while (lines.at(-1) === '') lines.pop()
  const firstError = lines.findIndex((line) => line.startsWith(ERROR))
  if (firstError === -1) return tail(lines.join('\n'), maxBytes)
  const lastError = lines.findLastIndex((line) => line.startsWith(ERROR))
  const start = lines.slice(0, firstError).findLastIndex((line) => line.startsWith(STEP))
  return tail(lines.slice(Math.max(start, 0), lastError + 1).join('\n'), maxBytes)
}

function tail(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  const end = decoder.decode(bytes.slice(bytes.length - maxBytes))
  const newline = end.indexOf('\n')
  const kept = newline === -1 ? end.replace(/^\uFFFD/, '') : end.slice(newline + 1)
  return `[truncated by Phada: last ${encoder.encode(kept).length} of ${bytes.length} bytes]\n${kept}`
}
