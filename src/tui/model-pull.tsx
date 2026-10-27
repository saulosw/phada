import { Text } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { errorMessage } from '../app/error-message.js'
import type { OllamaPullProgress, OllamaPullResult } from '../app/read-provider.js'
import { useAppDeps, useWorking } from './app-context.js'
import type { UiMessages } from './i18n/messages.js'
import type { Theme } from './theme.js'
import { fit, oneLine, wrapText } from './text-fit.js'
import { modelSizeText } from './units.js'

export type ModelPullState =
  | { kind: 'idle' }
  | { kind: 'pulling'; model: string; progress: OllamaPullProgress | null }
  | { kind: 'ended'; model: string; result: OllamaPullResult }

export interface ModelPull {
  state: ModelPullState
  pulling: boolean
  start(model: string): void
  cancel(): void
  clear(): void
}

export interface ModelPullDraw {
  messages: UiMessages
  theme: Theme
  width: number
}

const IDLE: ModelPullState = { kind: 'idle' }
const BAR_WIDTH = 20

export function useModelPull(onPulled: (model: string) => void): ModelPull {
  const { pullModel } = useAppDeps()
  const [state, setState] = useState<ModelPullState>(IDLE)
  const running = useRef<AbortController | undefined>(undefined)
  const pulled = useRef(onPulled)
  pulled.current = onPulled
  useWorking(state.kind === 'pulling')
  useEffect(() => () => running.current?.abort(), [])

  const start = useCallback(
    (model: string) => {
      if (running.current !== undefined) return
      const controller = new AbortController()
      running.current = controller
      setState({ kind: 'pulling', model, progress: null })
      void pullModel(model, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (!controller.signal.aborted) setState({ kind: 'pulling', model, progress })
        },
      })
        .catch((error: unknown): OllamaPullResult => ({
          kind: 'failed',
          message: errorMessage(error),
        }))
        .then((result) => {
          running.current = undefined
          setState({ kind: 'ended', model, result })
          if (result.kind === 'pulled') pulled.current(model)
        })
    },
    [pullModel],
  )
  const cancel = useCallback(() => running.current?.abort(), [])
  const clear = useCallback(() => {
    if (running.current === undefined) setState(IDLE)
  }, [])
  return { state, pulling: state.kind === 'pulling', start, cancel, clear }
}

export function modelPullLines(state: ModelPullState, draw: ModelPullDraw): ReactNode[] {
  const { messages, theme, width } = draw
  const { colors } = theme
  const m = messages.provider.pick
  if (state.kind === 'idle') return []
  const model = oneLine(state.model)
  if (state.kind === 'pulling') {
    const { progress } = state
    return [
      <Text bold>{m.pulling(model)}</Text>,
      ...(progress === null
        ? []
        : [
            <Text color={colors.soft}>{fit(oneLine(progress.status), width)}</Text>,
            ...progressLine(progress, draw),
          ]),
    ]
  }
  const { result } = state
  const [text, color] =
    result.kind === 'pulled'
      ? [m.pulled(model), colors.ok]
      : result.kind === 'cancelled'
        ? [m.cancelled(model), colors.warn]
        : result.kind === 'stopped'
          ? [m.stopped, colors.warn]
          : result.message === null
            ? [m.ended(model), colors.error]
            : [m.failed(model, oneLine(result.message)), colors.error]
  return wrapText(text, width).map((line) => <Text color={color}>{line}</Text>)
}

function progressLine(progress: OllamaPullProgress, { messages, theme }: ModelPullDraw) {
  const { completed, total } = progress
  if (total === null || total <= 0) return []
  const done = Math.min(completed ?? 0, total)
  const percent = Math.floor((done / total) * 100)
  const filled = Math.round((done / total) * BAR_WIDTH)
  return [
    <Text>
      <Text color={theme.colors.accent}>{'━'.repeat(filled)}</Text>
      <Text color={theme.colors.dim}>{'─'.repeat(BAR_WIDTH - filled)}</Text>{' '}
      {messages.provider.pick.progress(modelSizeText(done), modelSizeText(total), percent)}
    </Text>,
  ]
}
