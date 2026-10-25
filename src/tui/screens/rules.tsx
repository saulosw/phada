import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { errorMessage } from '../../app/error-message.js'
import type { PromptPassView, PromptView } from '../../app/inspect-prompt.js'
import type { ListedRepository } from '../../app/read-repositories.js'
import type { BranchRules, LocalRules, ReadRules } from '../../app/read-rules.js'
import type { ConfiguredLens } from '../../app/review-passes.js'
import type { LayerOrigin } from '../../config/layer-label.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import { useLoaded, usePolled } from '../data-hooks.js'
import type { DataState } from '../data-hooks.js'
import { DataView } from '../data-view.js'
import type { UiMessages } from '../i18n/messages.js'
import { ScrollList, ScrollText, useSelection } from '../scroll-list.js'
import { textWidth } from '../tab-layout.js'
import { TextFieldLine, useTextField } from '../text-field.js'
import type { Theme } from '../theme.js'
import { fit, oneLine, wrapText } from '../text-fit.js'
import { bytesText } from '../units.js'
import { shortenHome } from './home.js'
import { ruleLines } from './repositories.js'

const GAP = '  '
const SHORT_SHA = 7
const NAME_SHARE = 0.4
const EVERYWHERE = '**'
const PULL_NUMBER = /^[1-9]\d*$/
const MIN_NAME_WIDTH = 16

const repoKey = ({ repo }: ListedRepository) => repo

type ContextReport = ReadRules['report']
type RuleReport = ContextReport['rules'][number]
type DocReport = ContextReport['docs'][number]

interface Draw {
  messages: UiMessages
  theme: Theme
  home: string
  width: number
}

export function RulesScreen() {
  const [open, setOpen] = useState<string | undefined>()
  return (
    <>
      <RepositoryPicker active={open === undefined} onOpen={setOpen} />
      {open !== undefined && <RepositoryRules repo={open} onClose={() => setOpen(undefined)} />}
    </>
  )
}

function RepositoryPicker({ active, onOpen }: { active: boolean; onOpen(repo: string): void }) {
  const { readRepositories } = useAppDeps()
  const messages = useMessages()
  const size = useScreenSize()
  const { colors } = useTheme()
  const state = usePolled(readRepositories)
  const repositories = state.status === 'ready' ? state.value.repositories : []
  const selection = useSelection(repositories, repoKey, {
    active,
    onOpen: (entry) => onOpen(entry.repo),
  })
  useScreenKeys(
    !active || repositories.length === 0
      ? []
      : [
          { keys: '↑/↓', label: messages.keys.select },
          { keys: 'Enter', label: messages.keys.open },
        ],
  )
  if (!active) return null
  const m = messages.rules
  const originsOf = (entry: ListedRepository) =>
    entry.origins.map((origin) => messages.repositories.origins[origin]).join(', ')
  const nameWidth = Math.min(
    Math.max(0, ...repositories.map(({ repo }) => textWidth(oneLine(repo)))),
    Math.max(
      size.columns -
        4 -
        GAP.length -
        Math.max(0, ...repositories.map((entry) => textWidth(originsOf(entry)))),
      MIN_NAME_WIDTH,
    ),
  )
  return (
    <DataView state={state}>
      {(list) =>
        list.repositories.length === 0 ? (
          <Box flexDirection="column">
            <Text>{m.none}</Text>
            <Text color={colors.dim}>{m.noneHint}</Text>
            <Text bold color={colors.accent}>
              {'  phada review owner/repo#N'}
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column" width={size.columns}>
            <Text color={colors.dim} wrap="truncate-end">
              {m.pick}
            </Text>
            <ScrollList
              items={list.repositories}
              index={selection.index}
              rows={Math.max(size.rows - 1, 1)}
              keyOf={repoKey}
              renderItem={(entry) => (
                <>
                  {fit(oneLine(entry.repo), nameWidth, 'start')}
                  {GAP}
                  <Text color={colors.dim}>{originsOf(entry)}</Text>
                </>
              )}
            />
          </Box>
        )
      }
    </DataView>
  )
}

function RepositoryRules({ repo, onClose }: { repo: string; onClose(): void }) {
  const { readLocalRules } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const [pull, setPull] = useState<number | undefined>()
  const [invalid, setInvalid] = useState<string | undefined>()
  const local = usePolled(() => readLocalRules(repo), undefined, repo)
  const field = useTextField({
    onSubmit: (value) => {
      const typed = value.trim()
      if (PULL_NUMBER.test(typed)) {
        setInvalid(undefined)
        setPull(Number(typed))
      } else {
        setInvalid(typed)
      }
    },
  })
  useScreenInput((input) => {
    if (input === 'p') field.focus()
  })
  useBack(pull === undefined ? onClose : () => setPull(undefined))
  const m = messages.rules
  useScreenKeys(
    field.focused
      ? [
          { keys: 'Enter', label: messages.field.apply },
          { keys: 'Esc', label: messages.field.cancel },
        ]
      : [
          { keys: '↑/↓', label: messages.list.scroll },
          { keys: 'r', label: messages.keys.refresh },
          { keys: 'p', label: m.pullKey },
          { keys: 'Esc', label: messages.keys.back },
        ],
  )
  const footer: ReactNode[] = [
    ...(invalid === undefined || field.focused
      ? []
      : [<Text color={theme.colors.warn}>{oneLine(m.invalidNumber(invalid))}</Text>]),
    ...(field.focused ? [<TextFieldLine label={m.pullField} field={field} />] : []),
  ]
  const rows = Math.max(size.rows - footer.length, 1)
  return (
    <Box flexDirection="column" width={size.columns}>
      {pull === undefined ? (
        <BranchView repo={repo} local={local} rows={rows} active={!field.focused} />
      ) : (
        <PullView key={pull} repo={repo} pull={pull} rows={rows} active={!field.focused} />
      )}
      {footer.map((line, index) => (
        <Text key={index} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  )
}

function BranchView({
  repo,
  local,
  rows,
  active,
}: {
  repo: string
  local: DataState<LocalRules>
  rows: number
  active: boolean
}) {
  const { readRepositoryRules } = useAppDeps()
  const { state } = useLoaded(() => readRepositoryRules(repo))
  const draw = useDraw()
  const m = draw.messages.rules
  const read = state.status === 'ready' && state.value.status === 'read' ? state.value : undefined
  const lines: ReactNode[] = [
    <Text bold>{oneLine(repo)}</Text>,
    ...lensLines(read?.lens, local, draw),
    ...(read === undefined && state.status !== 'loading' ? note(m.localOnly, draw) : []),
    <Text> </Text>,
    ...userRuleLines(local, draw),
    <Text> </Text>,
    ...branchLines(state, draw),
  ]
  return <ScrollText lines={lines} rows={rows} active={active} />
}

function PullView({
  repo,
  pull,
  rows,
  active,
}: {
  repo: string
  pull: number
  rows: number
  active: boolean
}) {
  const { readPullRequestRules } = useAppDeps()
  const { state } = useLoaded(() => readPullRequestRules(repo, pull))
  const draw = useDraw()
  const { messages } = draw
  const { colors } = draw.theme
  const m = messages.rules
  const title = <Text bold>{`${oneLine(repo)}#${pull}`}</Text>
  if (state.status !== 'ready') {
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">{title}</Text>
        <DataView state={state}>{() => null}</DataView>
      </Box>
    )
  }
  if (state.value.status === 'no-token') {
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">{title}</Text>
        <Text color={colors.warn} wrap="truncate-end">
          {m.noToken}
        </Text>
      </Box>
    )
  }
  const { rules, prompt } = state.value
  const head = prompt.pullRequest
  const lines: ReactNode[] = [
    <Text>
      {title}
      {head === null ? (
        ''
      ) : (
        <Text color={colors.soft}>
          {' · '}
          {m.commits(head.headSha.slice(0, SHORT_SHA), head.baseSha.slice(0, SHORT_SHA))}
        </Text>
      )}
    </Text>,
    ...lensLines(rules.lens, undefined, draw),
    <Text> </Text>,
    <Text bold>{m.loadedRules}</Text>,
    ...reportLines(rules, draw),
    <Text> </Text>,
    ...promptLines(prompt, draw),
  ]
  return <ScrollText lines={lines} rows={rows} active={active} />
}

function useDraw(): Draw {
  const messages = useMessages()
  const theme = useTheme()
  const { home } = useAppDeps()
  const { columns } = useScreenSize()
  return { messages, theme, home, width: columns }
}

function lensLines(
  effective: ConfiguredLens | undefined,
  local: DataState<LocalRules> | undefined,
  draw: Draw,
): ReactNode[] {
  const { messages, theme } = draw
  const m = messages.rules
  const lens = effective ?? (local?.status === 'ready' ? local.value.lens : undefined)
  if (lens === undefined) {
    return local?.status === 'failed'
      ? [
          <Text>
            <Text color={theme.colors.soft}>{m.lens}</Text>
            {GAP}
            <Text color={theme.colors.error}>{messages.failed(errorMessage(local.error))}</Text>
          </Text>,
        ]
      : [
          <Text>
            <Text color={theme.colors.soft}>{m.lens}</Text>
            {GAP}
            <Text color={theme.colors.dim}>{messages.loading}</Text>
          </Text>,
        ]
  }
  const label = ' '.repeat(textWidth(m.lens))
  const origin = lens.kind === 'built-in' ? undefined : lens.setBy
  const value = lensText(lens, draw)
  return [
    <Text>
      <Text color={theme.colors.soft}>{m.lens}</Text>
      {GAP}
      <Text bold color={theme.colors.accent}>
        {value}
      </Text>
    </Text>,
    ...(origin === undefined
      ? []
      : [
          <Text color={theme.colors.dim}>
            {label}
            {GAP}
            {m.setBy(originText(origin, messages))}
          </Text>,
        ]),
  ]
}

function lensText(lens: ConfiguredLens, { messages, home }: Draw): string {
  const m = messages.rules
  const promptText = (prompt: { file: string; mode: 'append' | 'replace' }) =>
    m.prompt(oneLine(shortenHome(prompt.file, home)), m.promptModes[prompt.mode])
  if (lens.kind === 'built-in') return m.builtIn
  if (lens.kind === 'prompt') return promptText(lens.prompt)
  const names = lens.skills.entries
    .map(({ name, mode }) => (mode === 'native' ? `${name} (${m.native})` : name))
    .map(oneLine)
    .join(', ')
  return lens.prompt === null ? m.skills(names) : `${m.skills(names)} · ${promptText(lens.prompt)}`
}

function originText(origin: LayerOrigin, messages: UiMessages): string {
  const m = messages.rules
  if (origin.kind === 'repository-file') return m.layers.phada(oneLine(origin.name))
  return m.layers[origin.kind]
}

function userRuleLines(local: DataState<LocalRules>, draw: Draw): ReactNode[] {
  const { messages, theme, width } = draw
  const m = messages.rules
  if (local.status === 'loading') return [<Text color={theme.colors.dim}>{messages.loading}</Text>]
  if (local.status === 'failed') {
    return [
      <Text bold>{m.userRules(0)}</Text>,
      ...note(messages.failed(errorMessage(local.error)), draw, theme.colors.error),
    ]
  }
  const { rules, warnings } = local.value
  return [
    <Text bold>{m.userRules(rules.length)}</Text>,
    ...(rules.length === 0 ? note(m.noUserRules, draw) : ruleLines(rules, messages, theme, width)),
    ...warnings.flatMap((warning) => note(warning, draw, theme.colors.warn)),
  ]
}

function branchLines(state: DataState<BranchRules>, draw: Draw): ReactNode[] {
  const { messages, theme } = draw
  const m = messages.rules
  if (state.status === 'loading') {
    return [<Text bold>{m.phadaFolder}</Text>, ...note(messages.loading, draw)]
  }
  if (state.status === 'failed') {
    return [
      <Text bold>{m.phadaFolder}</Text>,
      ...note(messages.failed(errorMessage(state.error)), draw, theme.colors.error),
    ]
  }
  const read = state.value
  if (read.status === 'no-token') {
    return [<Text bold>{m.phadaFolder}</Text>, ...note(m.noToken, draw, theme.colors.warn)]
  }
  if (read.status === 'empty') return [<Text bold>{m.phadaFolder}</Text>, ...note(m.empty, draw)]
  const ref = read.target.kind === 'default-branch' ? read.target.ref : read.target.baseSha
  return [
    <Text bold>{m.atBranch(oneLine(ref))}</Text>,
    ...reportLines(read, draw),
    ...(read.ignore.length === 0
      ? []
      : [
          <Text>
            {'  '}
            <Text color={theme.colors.soft}>{m.ignore}</Text>
            {GAP}
            {read.ignore.map(oneLine).join(', ')}
          </Text>,
        ]),
  ]
}

function reportLines(read: ReadRules, draw: Draw): ReactNode[] {
  const { messages, theme } = draw
  const { colors } = theme
  const m = messages.rules
  const { report } = read
  if (report.configFiles.length === 0 && report.rules.length === 0 && report.docs.length === 0) {
    return [
      ...note(m.nothingLoaded, draw),
      <Text color={colors.dim}>
        {'  '}
        {m.initHint}{' '}
        <Text bold color={colors.accent}>
          phada init
        </Text>
      </Text>,
      ...warningLines(report, draw),
    ]
  }
  return [
    ...section(
      m.configFiles(report.configFiles.length),
      report.configFiles.map((file) => [
        file.path,
        file.status === 'invalid'
          ? messages.settings.invalid(file.message ?? '')
          : m.configOrigins[file.origin],
        file.status === 'invalid' ? colors.error : undefined,
      ]),
      draw,
    ),
    ...section(
      m.rules(report.rules.length),
      report.rules.map((rule) => [
        rule.key,
        ruleNotes(rule, messages),
        rule.status === 'disabled' || rule.status === 'out-of-scope' ? colors.dim : undefined,
      ]),
      draw,
    ),
    ...section(
      m.docs(report.docs.length),
      report.docs.map((doc) => [
        doc.path,
        docNotes(doc, messages),
        doc.status === 'omitted' ? colors.dim : undefined,
      ]),
      draw,
    ),
    ...warningLines(report, draw),
  ]
}

function warningLines(report: ContextReport, draw: Draw): ReactNode[] {
  return report.warnings.flatMap((warning) => note(warning, draw, draw.theme.colors.warn))
}

type Row = readonly [name: string, notes: string, color: string | undefined]

function section(heading: string, rows: readonly Row[], draw: Draw): ReactNode[] {
  if (rows.length === 0) return []
  const { colors } = draw.theme
  const names = rows.map(([name]) => oneLine(name))
  const nameWidth = Math.min(
    Math.max(...names.map(textWidth)),
    Math.floor((draw.width - 4) * NAME_SHARE),
  )
  return [
    <Text color={colors.soft}>
      {'  '}
      {heading}
    </Text>,
    ...rows.map(([, notes, color], index) => (
      <Text color={color}>
        {'    '}
        {fit(names[index] ?? '', nameWidth, 'start')}
        {GAP}
        <Text color={color ?? colors.dim}>{oneLine(notes)}</Text>
      </Text>
    )),
  ]
}

function ruleNotes(rule: RuleReport, messages: UiMessages): string {
  const m = messages.rules
  return [
    rule.origin,
    ...(rule.severity === undefined ? [] : [rule.severity]),
    ...(rule.scope.some((pattern) => pattern !== EVERYWHERE) ? [rule.scope.join(', ')] : []),
    ...(rule.status === 'applied' || rule.status === 'listed' ? [] : [m.ruleStatuses[rule.status]]),
  ].join(' · ')
}

function docNotes(doc: DocReport, messages: UiMessages): string {
  const m = messages.rules
  const scope = doc.scope === undefined ? undefined : doc.scope.join(', ')
  return [
    bytesText(doc.bytes),
    ...(doc.status === 'listed' ? [] : [m.docStatuses[doc.status]]),
    ...(doc.reason === undefined ? [] : [m.docReasons[doc.reason]]),
    ...(scope === undefined ? [] : [m.appliesTo(scope)]),
  ].join(' · ')
}

function promptLines(prompt: PromptView, draw: Draw): ReactNode[] {
  const { messages, theme } = draw
  const { colors } = theme
  const m = messages.rules
  return [
    <Text bold>{m.promptHeading}</Text>,
    ...prompt.warnings.flatMap((warning) => note(warning, draw, colors.warn)),
    ...note(m.computed, draw),
    ...prompt.passes.flatMap((pass, index) => passLines(pass, index, draw)),
  ]
}

function passLines(pass: PromptPassView, index: number, draw: Draw): ReactNode[] {
  const { messages, theme, width } = draw
  const { colors } = theme
  const m = messages.rules
  const where = pass.origin === 'phada' ? m.builtInOrigin : oneLine(pass.origin)
  const heading = (
    <Text>
      {'  '}
      <Text bold color={colors.accent}>
        {m.pass(index + 1, oneLine(pass.skill))}
      </Text>
      <Text color={colors.dim}>
        {' '}
        ({pass.mode === 'native' ? `${m.native}, ` : ''}
        {where})
      </Text>
    </Text>
  )
  if (pass.status === 'skipped') {
    return [heading, ...note(m.skipped(pass.reason ?? ''), draw)]
  }
  const nameWidth = Math.max(0, ...pass.data.map(({ name }) => textWidth(name)))
  return [
    <Text> </Text>,
    heading,
    ...(pass.native === undefined
      ? []
      : note(m.nativeMessage(pass.native.message), draw, colors.soft, 4)),
    ...(pass.data.length === 0
      ? []
      : [
          <Text color={colors.soft}>
            {'    '}
            {m.dataBlocks}
          </Text>,
          ...pass.data.map(({ name, bytes }) => (
            <Text>
              {'      '}
              {name.padEnd(nameWidth)}
              {GAP}
              <Text color={colors.dim}>{bytesText(bytes)}</Text>
            </Text>
          )),
        ]),
    <Text color={colors.soft}>
      {'    '}
      {m.instructions}
    </Text>,
    ...pass.parts.flatMap((part) => [
      <Text color={colors.dim}>
        {'    '}
        {`── ${part.section} · ${oneLine(part.origin)}`}
      </Text>,
      ...wrapText(part.text, width - 4).map((line) => (
        <Text>
          {'    '}
          {line}
        </Text>
      )),
    ]),
  ]
}

function note(text: string, draw: Draw, color = draw.theme.colors.dim, indent = 2): ReactNode[] {
  const pad = ' '.repeat(indent)
  return wrapText(text, draw.width - indent).map((line) => (
    <Text color={color}>{`${pad}${line}`}</Text>
  ))
}
