import { Box, Text, useInput } from 'ink'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AppDepsContext,
  ConfigWrittenContext,
  MessagesContext,
  ScreenContext,
  ThemeContext,
  WorkingContext,
  useAppDeps,
  useMessages,
  useTheme,
} from './app-context.js'
import type { AppDeps, KeyHint, ScreenControls, WorkingSignal } from './app-context.js'
import { POLL_MS, usePolled } from './data-hooks.js'
import { ErrorBoundary } from './error-boundary.js'
import { Footer } from './footer.js'
import { Help } from './help.js'
import { LanguagePicker } from './language-picker.js'
import { createLoadCache, LoadCacheContext } from './load-cache.js'
import type { UiMessages } from './i18n/messages.js'
import { uiMessagesFor } from './i18n/messages.js'
import { Palette } from './palette.js'
import type { PaletteEntry } from './palette.js'
import { SCREENS } from './screens.js'
import { Setup } from './setup/setup.js'
import { SubView } from './sub-view.js'
import type { ScreenDefinition } from './screens.js'
import { TabBar } from './tab-bar.js'
import { isTooSmall, useTerminalSize } from './terminal-size.js'
import type { SizeSource, TerminalSize } from './terminal-size.js'
import { colorLevel, resolveTheme } from './theme.js'

export type AppResult =
  | { kind: 'quit' }
  | { kind: 'interrupted' }
  | { kind: 'terminated' }
  | { kind: 'failed'; error: unknown }

export interface AppProps {
  deps: AppDeps
  size: SizeSource
  onExit(result: AppResult): void
  screens?: readonly ScreenDefinition[]
}

type Overlay = 'none' | 'help' | 'palette'
type Takeover = 'setup' | 'language'

const SHELL_ROWS = 3
const SETUP_ID = 'setup'
const LANGUAGE_ID = 'language'
const INDEX_ID = 'index'
const GRAPH_ID = 'graph'

export function App({ deps, size, onExit, screens = SCREENS }: AppProps) {
  const theme = useMemo(() => resolveTheme(colorLevel(deps.env)), [deps.env])
  const [workers, setWorkers] = useState(0)
  const start = useCallback(() => {
    let running = true
    setWorkers((count) => count + 1)
    return () => {
      if (!running) return
      running = false
      setWorkers((count) => count - 1)
    }
  }, [])
  const working = useMemo<WorkingSignal>(() => ({ working: workers > 0, start }), [workers, start])
  const fail = useCallback((error: unknown) => onExit({ kind: 'failed', error }), [onExit])
  const loads = useMemo(() => createLoadCache(() => deps.now().getTime()), [deps])
  const [configRound, setConfigRound] = useState(0)
  const configWritten = useCallback(() => setConfigRound((round) => round + 1), [])
  return (
    <ErrorBoundary onError={fail}>
      <AppDepsContext.Provider value={deps}>
        <ThemeContext.Provider value={theme}>
          <WorkingContext.Provider value={working}>
            <LoadCacheContext.Provider value={loads}>
              <ConfigWrittenContext.Provider value={configWritten}>
                <Localized configRound={configRound}>
                  <Shell size={size} screens={screens} onExit={onExit} />
                </Localized>
              </ConfigWrittenContext.Provider>
            </LoadCacheContext.Provider>
          </WorkingContext.Provider>
        </ThemeContext.Provider>
      </AppDepsContext.Provider>
    </ErrorBoundary>
  )
}

function Localized({ configRound, children }: { configRound: number; children: ReactNode }) {
  const language = useLanguage(configRound)
  const messages = useMemo(() => uiMessagesFor(language), [language])
  return <MessagesContext.Provider value={messages}>{children}</MessagesContext.Provider>
}

function useLanguage(configRound: number): string | undefined {
  const deps = useAppDeps()
  const polled = usePolled(deps.readLanguage, POLL_MS, String(configRound))
  const last = useRef(deps.language)
  if (polled.status === 'ready') last.current = polled.value
  return last.current
}

function Shell({
  size: source,
  screens,
  onExit,
}: {
  size: SizeSource
  screens: readonly ScreenDefinition[]
  onExit(result: AppResult): void
}) {
  const messages = useMessages()
  const { start } = useAppDeps()
  const english = useMemo(() => uiMessagesFor('en'), [])
  const size = useTerminalSize(source)
  const tooSmall = isTooSmall(size)
  const [active, setActive] = useState(0)
  const [takeover, setTakeover] = useState<Takeover | undefined>(
    start === 'setup' ? 'setup' : undefined,
  )
  const [setupRun, setSetupRun] = useState(0)
  const [overlay, setOverlay] = useState<Overlay>('none')
  const [screenKeys, setScreenKeys] = useState<readonly KeyHint[]>([])
  const [typing, setTypingState] = useState(false)
  const typingNow = useRef(false)
  const setTyping = useCallback((on: boolean) => {
    typingNow.current = on
    setTypingState(on)
  }, [])
  const [arrows, setArrowsState] = useState(false)
  const arrowsNow = useRef(false)
  const claimArrows = useCallback((on: boolean) => {
    arrowsNow.current = on
    setArrowsState(on)
  }, [])
  const back = useRef<(() => void) | undefined>(undefined)
  const titles = screens.map((screen) => screen.title(messages))
  const quit = () => onExit({ kind: 'quit' })
  const show = (index: number) => {
    back.current = undefined
    setTakeover(undefined)
    setActive((index + screens.length) % screens.length)
  }
  const open = (next: Takeover) => {
    back.current = undefined
    if (next === 'setup') setSetupRun((run) => run + 1)
    setTakeover(next)
  }
  const leaveSetup = () =>
    show(
      Math.max(
        screens.findIndex(({ id }) => id === 'home'),
        0,
      ),
    )

  const controls = useMemo<ScreenControls>(
    () => ({
      inputActive: overlay === 'none' && !tooSmall,
      typing,
      size: { columns: size.columns, rows: Math.max(size.rows - SHELL_ROWS, 0) },
      setKeys: setScreenKeys,
      setBack: (handler) => {
        back.current = handler
      },
      isTyping: () => typingNow.current,
      setTyping,
      claimArrows,
    }),
    [overlay, tooSmall, typing, size.columns, size.rows, setTyping, claimArrows],
  )

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return onExit({ kind: 'interrupted' })
    if (tooSmall) {
      if (input === 'q' || key.escape) quit()
      return
    }
    if (overlay === 'palette' || typingNow.current) return
    if (overlay === 'help') {
      if (key.escape || input === '?') setOverlay('none')
      else if (input === 'q') quit()
      return
    }
    if (key.escape) return back.current === undefined ? quit() : back.current()
    if (input === 'q') return quit()
    if (input === '?') return setOverlay('help')
    if (input === '/') return setOverlay('palette')
    if (takeover !== undefined) return
    if (/^[1-9]$/.test(input)) {
      const index = Number(input) - 1
      if (index < screens.length) show(index)
      return
    }
    const arrow = !arrowsNow.current
    if ((arrow && key.rightArrow) || (key.tab && !key.shift)) return show(active + 1)
    if ((arrow && key.leftArrow) || (key.tab && key.shift)) return show(active - 1)
  })

  if (tooSmall) return <TooSmall size={size} />

  const current = screens[active]
  const global = globalKeys(messages, screens.length, takeover !== undefined, arrows)
  const setupTitle = messages.setup.title
  const languageTitle = { full: messages.language.title, short: messages.language.title }
  const takeoverTitle = takeover === 'language' ? languageTitle : setupTitle
  const paletteEntries: PaletteEntry[] = [
    ...screens.map((screen, index) => {
      const title = titles[index] ?? screen.title(messages)
      const englishTitle = screen.title(english)
      return {
        id: screen.id,
        label: title.full,
        names: [title.full, title.short, englishTitle.full, englishTitle.short],
      }
    }),
    {
      id: SETUP_ID,
      label: setupTitle.full,
      names: [setupTitle.full, setupTitle.short, english.setup.title.full],
    },
    {
      id: LANGUAGE_ID,
      label: languageTitle.full,
      names: [languageTitle.full, english.language.title],
    },
    ...(screens.some((screen) => screen.id === GRAPH_ID)
      ? [
          {
            id: INDEX_ID,
            label: messages.palette.index,
            names: [messages.palette.index, english.palette.index],
          },
        ]
      : []),
  ]
  const footerKeys =
    overlay === 'palette'
      ? [
          { keys: '↑/↓', label: messages.keys.select },
          { keys: 'Enter', label: messages.keys.open },
          { keys: 'Esc', label: messages.keys.close },
        ]
      : overlay === 'help'
        ? [{ keys: 'Esc', label: messages.keys.close }]
        : typing
          ? screenKeys
          : [...screenKeys, ...footerGlobals(messages, takeover !== undefined, arrows)]

  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      {takeover !== undefined ? (
        <TabBar titles={[takeoverTitle]} active={0} width={size.columns} />
      ) : (
        <TabBar titles={titles} active={active} width={size.columns} />
      )}
      <Box flexDirection="column" flexGrow={1} marginTop={1} overflow="hidden">
        {overlay === 'help' && (
          <Help
            global={global}
            screen={screenKeys}
            screenName={takeover !== undefined ? takeoverTitle.full : (titles[active]?.full ?? '')}
          />
        )}
        {overlay === 'palette' && (
          <Palette
            entries={paletteEntries}
            onClose={() => setOverlay('none')}
            onPick={(id) => {
              setOverlay('none')
              if (id === SETUP_ID) open('setup')
              else if (id === LANGUAGE_ID) open('language')
              else if (id === INDEX_ID) show(screens.findIndex((screen) => screen.id === GRAPH_ID))
              else show(screens.findIndex((screen) => screen.id === id))
            }}
          />
        )}
        <Box flexDirection="column" display={overlay === 'none' ? 'flex' : 'none'}>
          <ScreenContext.Provider value={controls}>
            {takeover === 'setup' ? (
              <Setup key={setupRun} onClose={leaveSetup} />
            ) : takeover === 'language' ? (
              <SubView onLeave={() => show(active)}>
                <LanguagePicker onDone={() => show(active)} />
              </SubView>
            ) : (
              current !== undefined && <current.Screen key={current.id} />
            )}
          </ScreenContext.Provider>
        </Box>
      </Box>
      <Footer
        hints={footerKeys}
        more={{ keys: '?', label: messages.keys.more }}
        width={size.columns}
      />
    </Box>
  )
}

function footerGlobals(messages: UiMessages, takenOver: boolean, arrows: boolean): KeyHint[] {
  return [
    ...(takenOver ? [] : [{ keys: arrows ? 'Tab' : '←/→', label: messages.keys.screens }]),
    { keys: '/', label: messages.keys.palette },
    { keys: '?', label: messages.keys.help },
    { keys: 'q', label: messages.keys.quit },
  ]
}

function globalKeys(
  messages: UiMessages,
  screens: number,
  takenOver: boolean,
  arrows: boolean,
): KeyHint[] {
  return [
    ...(takenOver
      ? []
      : [
          { keys: arrows ? 'Tab' : '←/→ Tab', label: messages.keys.cycle },
          { keys: `1–${Math.min(screens, 9)}`, label: messages.keys.jump },
        ]),
    { keys: '/', label: messages.keys.palette },
    { keys: '?', label: messages.keys.help },
    { keys: 'Esc', label: messages.keys.back },
    { keys: 'q', label: messages.keys.quit },
  ]
}

function TooSmall({ size }: { size: TerminalSize }) {
  const messages = useMessages()
  const { colors } = useTheme()
  return (
    <Box flexDirection="column" width={size.columns}>
      <Text color={colors.warn}>{messages.tooSmall(size.columns, size.rows)}</Text>
      <Text color={colors.dim}>{messages.tooSmallHint}</Text>
    </Box>
  )
}
