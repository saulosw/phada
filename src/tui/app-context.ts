import { useInput } from 'ink'
import type { Key } from 'ink'
import { createContext, useContext, useEffect, useRef } from 'react'
import type { HistoryFilter, ListedRun, ReviewDetail } from '../app/read-history.js'
import type { QueueView } from '../app/read-queue.js'
import type { AutomationView } from '../app/read-automation.js'
import type { RepositoryDetail, RepositoryList } from '../app/read-repositories.js'
import type { UiMessages } from './i18n/messages.js'
import type { TerminalSize } from './terminal-size.js'
import type { ColorEnv, Theme } from './theme.js'

export interface Scheduler {
  every(ms: number, tick: () => void): () => void
}

export interface AppDeps {
  version: string
  cwd: string
  home: string
  env: ColorEnv
  scheduler: Scheduler
  language?: string
  configError?: unknown
  now(): Date
  readQueue(): Promise<QueueView>
  readReviews(filter: HistoryFilter): Promise<{ runs: ListedRun[]; total: number }>
  readReviewDetail(id: number): Promise<ReviewDetail | undefined>
  readRepositories(): Promise<RepositoryList>
  readRepository(repo: string): Promise<RepositoryDetail>
  readAutomation(): Promise<AutomationView>
}

export interface KeyHint {
  keys: string
  label: string
}

export interface ScreenControls {
  inputActive: boolean
  typing: boolean
  size: TerminalSize
  setKeys(hints: readonly KeyHint[]): void
  setBack(back: (() => void) | undefined): void
  isTyping(): boolean
  setTyping(typing: boolean): void
}

export interface WorkingSignal {
  working: boolean
  start(): () => void
}

export const AppDepsContext = createContext<AppDeps | undefined>(undefined)
export const ThemeContext = createContext<Theme>({ level: 'none', colors: {} })
export const MessagesContext = createContext<UiMessages | undefined>(undefined)
export const WorkingContext = createContext<WorkingSignal>({
  working: false,
  start: () => () => {},
})
export const ScreenContext = createContext<ScreenControls>({
  inputActive: false,
  typing: false,
  size: { columns: 80, rows: 21 },
  setKeys: () => {},
  setBack: () => {},
  isTyping: () => false,
  setTyping: () => {},
})

export function useAppDeps(): AppDeps {
  const deps = useContext(AppDepsContext)
  if (deps === undefined) throw new Error('useAppDeps() outside the app')
  return deps
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}

export function useMessages(): UiMessages {
  const messages = useContext(MessagesContext)
  if (messages === undefined) throw new Error('useMessages() outside the app')
  return messages
}

export function useIsWorking(): boolean {
  return useContext(WorkingContext).working
}

export function useWorking(active: boolean): void {
  const { start } = useContext(WorkingContext)
  useEffect(() => (active ? start() : undefined), [active, start])
}

export function useScreenKeys(hints: readonly KeyHint[]): void {
  const { setKeys } = useContext(ScreenContext)
  const signature = JSON.stringify(hints)
  useEffect(() => {
    setKeys(JSON.parse(signature) as KeyHint[])
    return () => setKeys([])
  }, [signature, setKeys])
}

export function useBack(back: (() => void) | undefined): void {
  const { setBack } = useContext(ScreenContext)
  const latest = useRef(back)
  latest.current = back
  const open = back !== undefined
  useEffect(() => {
    if (!open) return undefined
    setBack(() => latest.current?.())
    return () => setBack(undefined)
  }, [open, setBack])
}

export function useScreenInput(handler: (input: string, key: Key) => void): void {
  const { inputActive, isTyping } = useContext(ScreenContext)
  useInput(
    (input, key) => {
      if (!isTyping()) handler(input, key)
    },
    { isActive: inputActive },
  )
}

export function useScreenSize(): TerminalSize {
  return useContext(ScreenContext).size
}
