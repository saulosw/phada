import type { ReviewPrompt, ReviewProvider, SkillRunRequest } from '../providers/types.js'
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
  const runSkill = provider.runSkill?.bind(provider)
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
    ...(runSkill === undefined
      ? {}
      : {
          async runSkill(request: SkillRunRequest) {
            const stop = showProgress(`Running the skill with ${provider.id}…`, output)
            try {
              return await runSkill(request)
            } finally {
              stop()
            }
          },
        }),
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

export function indexProgress(output: TextOutput): {
  extracting(total: number): void
  extracted(done: number, total: number): void
} {
  const live = output.isTTY === true
  return {
    extracting: (total) => {
      if (total === 0) return
      const files = `${total.toLocaleString('en-US')} file${total === 1 ? '' : 's'}`
      output.write(live ? `Indexing 0/${files}…` : `Indexing ${files}…\n`)
    },
    extracted: (done, total) => {
      if (!live) return
      output.write(`\rIndexing ${done}/${total} files…${done === total ? '\n' : ''}`)
    },
  }
}
