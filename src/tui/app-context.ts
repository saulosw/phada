import { useInput } from 'ink'
import type { Key } from 'ink'
import { createContext, useContext, useEffect, useRef } from 'react'
import type { AppliedUserConfig, UserConfigPlanResult } from '../app/edit-user-config.js'
import type { HistoryFilter, ListedRun, ReviewDetail } from '../app/read-history.js'
import type { GitHubAccess } from '../app/read-home.js'
import type { Learnings } from '../app/read-learnings.js'
import type { ProviderReport, ProviderSetup } from '../app/read-provider.js'
import type { QueueView } from '../app/read-queue.js'
import type { AutomationView } from '../app/read-automation.js'
import type { BranchRules, LocalRules, PullRequestRules } from '../app/read-rules.js'
import type { RepositoryDetail, RepositoryList } from '../app/read-repositories.js'
import type { UserConfigChange, UserConfigPlan } from '../config/user-config-edit.js'
import type { UiMessages } from './i18n/messages.js'
import type { TerminalSize } from './terminal-size.js'
import type { ColorEnv, Theme } from './theme.js'

export interface Scheduler {
  every(ms: number, tick: () => void): () => void
}

export type HandOffTarget =
  { kind: 'command'; command: string; args: readonly string[] } | { kind: 'editor'; file: string }

export type HandOffResult =
  { kind: 'exited'; exitCode: number } | { kind: 'not-found'; command: string }

export type AppStart = 'home' | 'setup'

export interface AppDeps {
  version: string
  start: AppStart
  cwd: string
  home: string
  env: ColorEnv
  scheduler: Scheduler
  language?: string
  now(): Date
  readLanguage(): Promise<string | undefined>
  readQueue(): Promise<QueueView>
  readReviews(filter: HistoryFilter): Promise<{ runs: ListedRun[]; total: number }>
  readReviewDetail(id: number): Promise<ReviewDetail | undefined>
  readRepositories(): Promise<RepositoryList>
  readRepository(repo: string): Promise<RepositoryDetail>
  readAutomation(): Promise<AutomationView>
  readProviderSetup(): Promise<ProviderSetup>
  readProviders(): Promise<ProviderReport>
  readLearnings(): Promise<Learnings>
  readGitHub(): Promise<GitHubAccess>
  readLocalRules(repo: string): Promise<LocalRules>
  readRepositoryRules(repo: string): Promise<BranchRules>
  readPullRequestRules(repo: string, number: number): Promise<PullRequestRules>
  handOff(target: HandOffTarget): Promise<HandOffResult>
  planConfig(changes: readonly UserConfigChange[]): Promise<UserConfigPlanResult>
  applyConfig(plan: UserConfigPlan): Promise<AppliedUserConfig>
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
export const ConfigWrittenContext = createContext<() => void>(() => {})
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

export function useConfigWritten(): () => void {
  return useContext(ConfigWrittenContext)
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
