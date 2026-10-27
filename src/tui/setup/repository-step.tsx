import { Text } from 'ink'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RepositoryFolder, RepositoryInit } from '../../app/repository-folder.js'
import {
  useAppDeps,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
  useWorking,
} from '../app-context.js'
import type { DataState } from '../data-hooks.js'
import { failedLines } from '../data-view.js'
import { settle } from '../load-cache.js'
import { ScrollText } from '../scroll-list.js'
import { fit, oneLine, shortenHome, wrapText } from '../text-fit.js'
import type { SetupStepProps } from './setup-steps.js'

type InitState = { status: 'idle' } | { status: 'creating' } | DataState<RepositoryInit>

export function RepositoryStep({ next }: SetupStepProps) {
  const { cwd, home, initRepository, readRepositoryFolder } = useAppDeps()
  const messages = useMessages()
  const { colors } = useTheme()
  const size = useScreenSize()
  const m = messages.setup.repository
  const [folder, setFolder] = useState<DataState<RepositoryFolder>>({ status: 'loading' })
  const [init, setInit] = useState<InitState>({ status: 'idle' })
  const started = useRef(false)
  const mounted = useRef(true)
  useWorking(folder.status === 'loading' || init.status === 'creating')
  useEffect(() => {
    mounted.current = true
    void settle(readRepositoryFolder).then((state) => {
      if (mounted.current) setFolder(state)
    })
    return () => {
      mounted.current = false
    }
  }, [readRepositoryFolder])

  const offers =
    folder.status === 'ready' && folder.value.kind === 'unconfigured' && init.status === 'idle'
  const goesOn = folder.status !== 'loading' && !offers && init.status !== 'creating'
  useScreenInput((_input, key) => {
    if (!key.return) return
    if (offers) {
      if (started.current) return
      started.current = true
      setInit({ status: 'creating' })
      void settle(initRepository).then((state) => {
        if (mounted.current) setInit(state)
      })
    } else if (goesOn) {
      next(init.status === 'ready' ? { init: init.value } : {})
    }
  })
  useScreenKeys(
    offers
      ? [{ keys: 'Enter', label: m.create }]
      : goesOn
        ? [{ keys: 'Enter', label: messages.setup.continue }]
        : [],
  )

  const shown = (path: string) => shortenHome(oneLine(path), home)
  const wrapped = (text: string, color?: string) =>
    wrapText(text, size.columns).map((line) => <Text color={color}>{line}</Text>)
  const folderLines = (): ReactNode[] => {
    if (folder.status === 'loading') return [<Text color={colors.dim}>{m.checking}</Text>]
    if (folder.status === 'failed') {
      return failedLines(messages, folder.error, size.columns).map((line) => (
        <Text color={colors.error}>{line}</Text>
      ))
    }
    const value = folder.value
    switch (value.kind) {
      case 'outside':
        return wrapped(m.outside(shown(cwd)))
      case 'configured':
        return wrapped(m.configured(shown(value.root)))
      case 'unconfigured':
        if (init.status === 'ready') return wrapped(m.initialized(shown(init.value.root)))
        return [
          ...wrapped(m.offer(shown(value.root)), colors.warn),
          <Text> </Text>,
          ...wrapped(m.why, colors.soft),
        ]
    }
  }
  const initLines = (): ReactNode[] => {
    switch (init.status) {
      case 'idle':
      case 'loading':
        return []
      case 'creating':
        return [<Text> </Text>, <Text color={colors.dim}>{m.creating}</Text>]
      case 'failed':
        return [
          <Text> </Text>,
          ...failedLines(messages, init.error, size.columns).map((line) => (
            <Text color={colors.error}>{line}</Text>
          )),
        ]
      case 'ready':
        return [
          <Text> </Text>,
          ...init.value.files.map(({ path, created }) => (
            <Text color={created ? colors.ok : colors.soft}>
              {fit(created ? m.created(oneLine(path)) : m.kept(oneLine(path)), size.columns)}
            </Text>
          )),
        ]
    }
  }
  return <ScrollText lines={[...folderLines(), ...initLines()]} rows={size.rows} />
}
