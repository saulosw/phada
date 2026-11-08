import type { BlockedCommand, FixOutput, FixRequest } from '../providers/types.js'
import { parseFixOutcomes } from '../review/fix-outcomes.js'
import type { FixOutcome } from '../review/fix-outcomes.js'
import { buildFixPrompt } from '../review/fix-prompt.js'
import type { FixTarget } from '../review/fix-prompt.js'
import { newNonce } from '../review/nonce.js'

const FIX_TIMEOUT_MS = 900_000
const FIX_MAX_TURNS = 60

export type FixAnswer =
  | {
      status: 'answered'
      outcomes: FixOutcome[]
      unreported: number[]
      summary: string
      blocked: BlockedCommand[]
    }
  | { status: 'failed'; error: unknown }

export async function askAiToFix(
  fix: (request: FixRequest) => Promise<FixOutput>,
  targets: readonly FixTarget[],
  cwd: string,
): Promise<FixAnswer> {
  const prompt = buildFixPrompt(targets, newNonce())
  try {
    const output = await fix({
      ...prompt,
      cwd,
      timeoutMs: FIX_TIMEOUT_MS,
      maxTurns: FIX_MAX_TURNS,
    })
    const parsed = parseFixOutcomes(
      output.text,
      targets.map(({ number }) => number),
    )
    return { status: 'answered', ...parsed, blocked: output.blocked }
  } catch (error) {
    return { status: 'failed', error }
  }
}
