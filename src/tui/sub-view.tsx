import { useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ScreenContext, useBack, useMessages, useScreenKeys } from './app-context.js'
import type { KeyHint, ScreenControls } from './app-context.js'

export function SubView({ onLeave, children }: { onLeave(): void; children: ReactNode }) {
  const outer = useContext(ScreenContext)
  const messages = useMessages()
  const [keys, setKeys] = useState<readonly KeyHint[]>([])
  const innerBack = useRef<(() => void) | undefined>(undefined)
  const [innerHasBack, setInnerHasBack] = useState(false)
  useBack(() => (innerBack.current === undefined ? onLeave() : innerBack.current()))
  useScreenKeys([
    ...keys,
    ...(innerHasBack || outer.typing ? [] : [{ keys: 'Esc', label: messages.keys.back }]),
  ])
  const controls = useMemo<ScreenControls>(
    () => ({
      ...outer,
      setKeys,
      setBack: (back) => {
        innerBack.current = back
        setInnerHasBack(back !== undefined)
      },
    }),
    [outer],
  )
  return <ScreenContext.Provider value={controls}>{children}</ScreenContext.Provider>
}
