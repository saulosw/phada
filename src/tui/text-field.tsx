import { Text, useInput } from 'ink'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { ScreenContext, useTheme } from './app-context.js'

export interface TextField {
  value: string
  draft: string
  focused: boolean
  focus(): void
}

export function useTextField(
  options: { initial?: string; emptyOnFocus?: boolean; onSubmit?(value: string): void } = {},
): TextField {
  const { inputActive, setTyping } = useContext(ScreenContext)
  const [value, setValue] = useState(options.initial ?? '')
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  const focusedNow = useRef(false)
  const draftNow = useRef(draft)
  const submit = useRef(options.onSubmit)
  submit.current = options.onSubmit
  const emptyOnFocus = options.emptyOnFocus ?? false

  const edit = (next: string) => {
    draftNow.current = next
    setDraft(next)
  }

  const leave = (apply: boolean) =>
    queueMicrotask(() => {
      focusedNow.current = false
      setTyping(false)
      setFocused(false)
      if (!apply) return
      const applied = draftNow.current
      setValue(applied)
      submit.current?.(applied)
    })

  useEffect(
    () => () => {
      if (focusedNow.current) setTyping(false)
    },
    [setTyping],
  )

  useInput(
    (input, key) => {
      if (!focusedNow.current) return
      if (key.escape) return leave(false)
      if (key.return) return leave(true)
      if (key.backspace || key.delete) return edit([...draftNow.current].slice(0, -1).join(''))
      if (key.ctrl && input === 'u') return edit('')
      if (key.ctrl || key.meta || key.tab || input === '') return
      for (const character of input) {
        if (character === '\r' || character === '\n') return leave(true)
        if (character === '\u001B') return leave(false)
        if (character === '\u007F' || character === '\b') {
          edit([...draftNow.current].slice(0, -1).join(''))
        } else if (!/\p{Cc}/u.test(character)) {
          edit(draftNow.current + character)
        }
      }
    },
    { isActive: inputActive },
  )

  const focus = useCallback(() => {
    queueMicrotask(() => {
      if (focusedNow.current) return
      focusedNow.current = true
      setTyping(true)
      edit(emptyOnFocus ? '' : value)
      setFocused(true)
    })
  }, [value, emptyOnFocus, setTyping])

  return { value, draft: focused ? draft : value, focused, focus }
}

export function TextFieldLine({ label, field }: { label: string; field: TextField }) {
  const { colors } = useTheme()
  return (
    <Text wrap="truncate-start">
      <Text bold color={field.focused ? colors.accent : colors.soft}>
        {label}:{' '}
      </Text>
      <Text>{field.draft}</Text>
      {field.focused && <Text inverse> </Text>}
    </Text>
  )
}
