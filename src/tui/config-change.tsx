import { Text } from 'ink'
import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppliedUserConfig, UserConfigPlanResult } from '../app/edit-user-config.js'
import type { UserConfigChange, UserConfigPlan, ValueChange } from '../config/user-config-edit.js'
import {
  useAppDeps,
  useConfigWritten,
  useMessages,
  useScreenInput,
  useWorking,
} from './app-context.js'
import type { KeyHint } from './app-context.js'
import type { UiMessages } from './i18n/messages.js'
import { textWidth } from './tab-layout.js'
import type { Theme } from './theme.js'
import { fit, oneLine, shortenHome, wrapText } from './text-fit.js'

export type ConfigProblem =
  Exclude<UserConfigPlanResult, { ok: true }> | Exclude<AppliedUserConfig, { ok: true }>

export type ConfigChangeState =
  | { kind: 'idle' }
  | { kind: 'planning' }
  | { kind: 'review'; plan: UserConfigPlan }
  | { kind: 'writing'; plan: UserConfigPlan }
  | { kind: 'problem'; problem: ConfigProblem }

export interface ConfigChange {
  state: ConfigChangeState
  open: boolean
  keys: KeyHint[]
  propose(changes: readonly UserConfigChange[]): void
  cancel(): void
}

export interface ConfigDraw {
  messages: UiMessages
  theme: Theme
  home: string
  width: number
}

const IDLE: ConfigChangeState = { kind: 'idle' }
const INDENT = '  '
const GAP = '  '

export function useConfigChange(onSaved: (plan: UserConfigPlan) => void): ConfigChange {
  const { planConfig, applyConfig } = useAppDeps()
  const written = useConfigWritten()
  const messages = useMessages()
  const [state, setState] = useState<ConfigChangeState>(IDLE)
  const round = useRef(0)
  const proposed = useRef<readonly UserConfigChange[]>([])
  const saved = useRef(onSaved)
  saved.current = onSaved
  useWorking(state.kind === 'planning' || state.kind === 'writing')

  const propose = useCallback(
    (changes: readonly UserConfigChange[]) => {
      const current = ++round.current
      proposed.current = changes
      setState({ kind: 'planning' })
      void planConfig(changes).then((planned) => {
        if (round.current !== current) return
        if (!planned.ok) return setState({ kind: 'problem', problem: planned })
        if (planned.plan.changes.length > 0) return setState({ kind: 'review', plan: planned.plan })
        setState(IDLE)
        saved.current(planned.plan)
      })
    },
    [planConfig],
  )
  const write = (plan: UserConfigPlan) => {
    const current = ++round.current
    setState({ kind: 'writing', plan })
    void applyConfig(plan).then((applied) => {
      if (round.current !== current) return
      if (!applied.ok) return setState({ kind: 'problem', problem: applied })
      setState(IDLE)
      written()
      saved.current(plan)
    })
  }
  const cancel = useCallback(() => {
    round.current += 1
    setState(IDLE)
  }, [])

  useScreenInput((_input, key) => {
    if (!key.return) return
    if (state.kind === 'review') write(state.plan)
    else if (state.kind === 'problem' && state.problem.reason === 'changed') {
      propose(proposed.current)
    }
  })

  const m = messages.config
  const keys: KeyHint[] =
    state.kind === 'review'
      ? [
          { keys: 'Enter', label: m.keys.save },
          { keys: 'Esc', label: m.keys.cancel },
        ]
      : state.kind === 'problem'
        ? [
            ...(state.problem.reason === 'changed' ? [{ keys: 'Enter', label: m.keys.again }] : []),
            { keys: 'Esc', label: m.keys.cancel },
          ]
        : state.kind === 'idle'
          ? []
          : [{ keys: 'Esc', label: m.keys.cancel }]
  return { state, open: state.kind !== 'idle', keys, propose, cancel }
}

export function configChangeLines(state: ConfigChangeState, draw: ConfigDraw): ReactNode[] {
  const { messages, theme, home, width } = draw
  const { colors } = theme
  const m = messages.config
  switch (state.kind) {
    case 'idle':
      return []
    case 'planning':
      return [<Text color={colors.dim}>{m.planning}</Text>]
    case 'review':
    case 'writing': {
      const { plan } = state
      const path = shortenHome(oneLine(plan.path), home)
      return [
        <Text bold>{plan.exists ? m.save(path) : m.create(path)}</Text>,
        ...valueChangeLines(plan.changes, draw),
        ...(plan.reformatted === true
          ? wrapText(m.reformatted, width).map((line) => <Text color={colors.warn}>{line}</Text>)
          : []),
        ...(state.kind === 'writing' ? [<Text color={colors.dim}>{m.writing}</Text>] : []),
      ]
    }
    case 'problem':
      return wrapText(problemText(state.problem, messages), width).map((line) => (
        <Text color={state.problem.reason === 'changed' ? colors.warn : colors.error}>{line}</Text>
      ))
  }
}

export function valueChangeLines(changes: readonly ValueChange[], draw: ConfigDraw): ReactNode[] {
  const parts = changes.map((change) => valueChangeParts(change, draw.messages))
  const keyWidth = Math.max(0, ...parts.map(({ key }) => textWidth(key)))
  const valueWidth = Math.max(draw.width - INDENT.length - keyWidth - GAP.length, 1)
  return parts.map(({ key, value }) => (
    <Text>
      {INDENT}
      <Text color={draw.theme.colors.soft}>{fit(key, keyWidth)}</Text>
      {GAP}
      {fit(value, valueWidth).trimEnd()}
    </Text>
  ))
}

function valueChangeParts(
  change: ValueChange,
  messages: UiMessages,
): { key: string; value: string } {
  const m = messages.config
  if (change.key === 'watch.repos') {
    return {
      key: change.key,
      value: [
        ...(change.added.length === 0 ? [] : [`+ ${change.added.map(oneLine).join(', ')}`]),
        ...(change.removed.length === 0 ? [] : [`− ${change.removed.map(oneLine).join(', ')}`]),
      ].join('  '),
    }
  }
  if (change.key === 'publish') {
    const publish = (on: boolean) => (on ? m.publish.on : m.publish.off)
    return {
      key: oneLine(change.repo),
      value: `${publish(change.before)} → ${publish(change.after)}`,
    }
  }
  const value = (text: string | null) => (text === null ? m.unset : oneLine(text))
  return { key: change.key, value: `${value(change.before)} → ${value(change.after)}` }
}

function problemText(problem: ConfigProblem, messages: UiMessages): string {
  const m = messages.config
  switch (problem.reason) {
    case 'invalid-config':
      return m.invalidConfig(oneLine(problem.message))
    case 'invalid-result':
      return m.invalidResult(oneLine(problem.message))
    case 'ollama-without-model':
      return m.ollamaWithoutModel
    case 'last-watched-repo':
      return m.lastWatchedRepo(oneLine(problem.repo), problem.settings.map(oneLine).join(', '))
    case 'not-watched':
      return m.notWatched(oneLine(problem.repo))
    case 'unreadable':
      return m.unreadable(oneLine(problem.message))
    case 'failed':
      return m.failed(oneLine(problem.message))
    case 'changed':
      return m.changed
  }
}
