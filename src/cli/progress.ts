import type { ReviewPrompt, ReviewProvider } from '../providers/types.js'
import { formatElapsed } from './units.js'

export interface TextOutput {
  write(text: string): unknown
  isTTY?: boolean
}

const TICK_MS = 1000
const CLEAR_LINE = '\r\u001B[2K'

export function withProgress(
  provider: ReviewProvider,
  output: TextOutput,
  action = 'Reviewing',
): ReviewProvider {
  return {
    id: provider.id,
    async review(prompt: ReviewPrompt) {
      const stop = showProgress(`${action} with ${provider.id}…`, output)
      try {
        return await provider.review(prompt)
      } finally {
        stop()
      }
    },
  }
}

function showProgress(label: string, output: TextOutput): () => void {
  if (output.isTTY !== true) {
    output.write(`${label} (this can take a few minutes)\n`)
    return () => {}
  }

  const startedAt = Date.now()
  const render = () =>
    output.write(`${CLEAR_LINE}${label} ${formatElapsed(Date.now() - startedAt)}`)
  render()
  const timer = setInterval(render, TICK_MS)
  timer.unref()
  return () => {
    clearInterval(timer)
    output.write(CLEAR_LINE)
  }
}
