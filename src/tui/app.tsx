import { Box, Text, useInput } from 'ink'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AppDepsContext,
  MessagesContext,
  ScreenContext,
  ThemeContext,
  WorkingContext,
  useAppDeps,
  useMessages,
  useTheme,
} from './app-context.js'
import type { AppDeps, KeyHint, ScreenControls, WorkingSignal } from './app-context.js'
import { usePolled } from './data-hooks.js'
import { ErrorBoundary } from './error-boundary.js'
import { Footer } from './footer.js'
import { Help } from './help.js'
import { createLoadCache, LoadCacheContext } from './load-cache.js'
import type { UiMessages } from './i18n/messages.js'
import { uiMessagesFor } from './i18n/messages.js'
import { Palette } from './palette.js'
import type { PaletteEntry } from './palette.js'
import { SCREENS } from './screens.js'
import { Setup } from './setup/setup.js'
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

const SHELL_ROWS = 3
const SETUP_ID = 'setup'

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
  return (
    <ErrorBoundary onError={fail}>
      <AppDepsContext.Provider value={deps}>
        <ThemeContext.Provider value={theme}>
          <WorkingContext.Provider value={working}>
            <LoadCacheContext.Provider value={loads}>
              <Localized>
                <Shell size={size} screens={screens} onExit={onExit} />
              </Localized>
            </LoadCacheContext.Provider>
          </WorkingContext.Provider>
        </ThemeContext.Provider>
      </AppDepsContext.Provider>
    </ErrorBoundary>
  )
}

function Localized({ children }: { children: ReactNode }) {
  const language = useLanguage()
  const messages = useMemo(() => uiMessagesFor(language), [language])
  return <MessagesContext.Provider value={messages}>{children}</MessagesContext.Provider>
}

function useLanguage(): string | undefined {
  const deps = useAppDeps()
  const polled = usePolled(deps.readLanguage)
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
  const [inSetup, setInSetup] = useState(start === 'setup')
  const [overlay, setOverlay] = useState<Overlay>('none')
  const [screenKeys, setScreenKeys] = useState<readonly KeyHint[]>([])
  const [typing, setTypingState] = useState(false)
  const typingNow = useRef(false)
  const setTyping = useCallback((on: boolean) => {
    typingNow.current = on
    setTypingState(on)
  }, [])
  const back = useRef<(() => void) | undefined>(undefined)
  const titles = screens.map((screen) => screen.title(messages))
  const quit = () => onExit({ kind: 'quit' })
  const show = (index: number) => {
    back.current = undefined
    setInSetup(false)
    setActive((index + screens.length) % screens.length)
  }
  const openSetup = () => {
    back.current = undefined
    setInSetup(true)
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
    }),
    [overlay, tooSmall, typing, size.columns, size.rows, setTyping],
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
    if (inSetup) return
    if (/^[1-9]$/.test(input)) {
      const index = Number(input) - 1
      if (index < screens.length) show(index)
      return
    }
    if (key.rightArrow || (key.tab && !key.shift)) return show(active + 1)
    if (key.leftArrow || (key.tab && key.shift)) return show(active - 1)
  })

  if (tooSmall) return <TooSmall size={size} />

  const current = screens[active]
  const global = globalKeys(messages, screens.length, inSetup)
  const setupTitle = messages.setup.title
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
          : [...screenKeys, ...footerGlobals(messages, inSetup)]

  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      {inSetup ? (
        <TabBar titles={[setupTitle]} active={0} width={size.columns} />
      ) : (
        <TabBar titles={titles} active={active} width={size.columns} />
      )}
      <Box flexDirection="column" flexGrow={1} marginTop={1} overflow="hidden">
        {overlay === 'help' && (
          <Help
            global={global}
            screen={screenKeys}
            screenName={inSetup ? setupTitle.full : (titles[active]?.full ?? '')}
          />
        )}
        {overlay === 'palette' && (
          <Palette
            entries={paletteEntries}
            onClose={() => setOverlay('none')}
            onPick={(id) => {
              setOverlay('none')
              if (id === SETUP_ID) openSetup()
              else show(screens.findIndex((screen) => screen.id === id))
            }}
          />
        )}
        <Box flexDirection="column" display={overlay === 'none' ? 'flex' : 'none'}>
          <ScreenContext.Provider value={controls}>
            {inSetup ? (
              <Setup onClose={leaveSetup} />
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

function footerGlobals(messages: UiMessages, inSetup: boolean): KeyHint[] {
  return [
    ...(inSetup ? [] : [{ keys: '←/→', label: messages.keys.screens }]),
    { keys: '/', label: messages.keys.palette },
    { keys: '?', label: messages.keys.help },
    { keys: 'q', label: messages.keys.quit },
  ]
}

function globalKeys(messages: UiMessages, screens: number, inSetup: boolean): KeyHint[] {
  return [
    ...(inSetup
      ? []
      : [
          { keys: '←/→ Tab', label: messages.keys.cycle },
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
