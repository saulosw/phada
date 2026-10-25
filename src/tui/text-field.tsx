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
  options: { initial?: string; onSubmit?(value: string): void } = {},
): TextField {
  const { inputActive, setTyping } = useContext(ScreenContext)
  const [value, setValue] = useState(options.initial ?? '')
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  const submit = useRef(options.onSubmit)
  submit.current = options.onSubmit

  useEffect(() => {
    if (!focused) return undefined
    setTyping(true)
    return () => setTyping(false)
  }, [focused, setTyping])

  useInput(
    (input, key) => {
      if (key.escape) {
        setDraft(value)
        return setFocused(false)
      }
      if (key.return) {
        setValue(draft)
        setFocused(false)
        return submit.current?.(draft)
      }
      if (key.backspace || key.delete) return setDraft((text) => [...text].slice(0, -1).join(''))
      if (key.ctrl && input === 'u') return setDraft('')
      if (key.ctrl || key.meta || key.tab || input === '' || /\p{Cc}/u.test(input)) return
      setDraft((text) => text + input)
    },
    { isActive: inputActive && focused },
  )

  const focus = useCallback(() => {
    setDraft(value)
    setFocused(true)
  }, [value])

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
