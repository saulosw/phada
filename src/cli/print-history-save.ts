import type { HistorySave } from '../app/requested-review.js'
import { toTerminalText } from '../app/terminal-text.js'
import type { TextOutput } from './progress.js'

export function printHistorySave(stderr: TextOutput, history: HistorySave): void {
  if (history.status === 'not-saved') {
    stderr.write(
      `Warning: ${toTerminalText(history.error)}. This review is not saved in the history.\n`,
    )
  }
  if (history.status === 'saved' && history.feedbackError !== undefined) {
    stderr.write(
      `Warning: could not save the comments' feedback in the history (${toTerminalText(history.feedbackError)}).\n`,
    )
  }
}

export function savedAsLine(history: HistorySave): string | undefined {
  if (history.status !== 'saved') return undefined
  return `Saved as run ${history.runId}: phada history show ${history.runId}`
}
