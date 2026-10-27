import { useApp } from 'ink'
import { useCallback, useRef, useState } from 'react'
import { useAppDeps } from './app-context.js'
import type { HandOffResult, HandOffTarget } from './app-context.js'

export type HandOffOutcome = HandOffResult | { kind: 'failed'; error: unknown }

export interface HandOff {
  running: boolean
  run(target: HandOffTarget): Promise<HandOffOutcome | undefined>
}

export function useHandOff(): HandOff {
  const { handOff } = useAppDeps()
  const { suspendTerminal } = useApp()
  const busy = useRef(false)
  const [running, setRunning] = useState(false)
  const run = useCallback(
    async (target: HandOffTarget): Promise<HandOffOutcome | undefined> => {
      if (busy.current) return undefined
      busy.current = true
      setRunning(true)
      let outcome: HandOffOutcome = { kind: 'failed', error: undefined }
      try {
        await suspendTerminal(async () => {
          outcome = await handOff(target)
        })
      } catch (error) {
        outcome = { kind: 'failed', error }
      } finally {
        busy.current = false
        setRunning(false)
      }
      return outcome
    },
    [handOff, suspendTerminal],
  )
  return { running, run }
}
