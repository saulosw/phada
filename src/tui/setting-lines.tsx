import { Text } from 'ink'
import type { ReactNode } from 'react'
import type { ConfigSetting, SettingOrigin } from '../app/read-repositories.js'
import type { UiMessages } from './i18n/messages.js'
import { textWidth } from './tab-layout.js'
import type { Theme } from './theme.js'
import { fit, oneLine } from './text-fit.js'
import { durationText } from './units.js'

const GAP = '  '
const INDENT = '  '

export function settingLines(
  settings: readonly ConfigSetting[],
  messages: UiMessages,
  theme: Theme,
  columns: number,
): ReactNode[] {
  const origins = Object.values(messages.settings.origins)
  const keyWidth = Math.max(0, ...settings.map(({ key }) => textWidth(key)))
  const originWidth = Math.max(...origins.map(textWidth))
  const valueWidth = Math.max(columns - INDENT.length - keyWidth - originWidth - GAP.length * 2, 1)
  return settings.map((setting) => (
    <Text>
      {INDENT}
      <Text color={theme.colors.soft}>{fit(setting.key, keyWidth)}</Text>
      {GAP}
      {fit(settingValue(setting, messages), valueWidth)}
      {GAP}
      <Text color={originColor(setting.origin, theme)} bold={setting.origin === 'repository'}>
        {messages.settings.origins[setting.origin]}
      </Text>
    </Text>
  ))
}

export function settingValue(setting: ConfigSetting, messages: UiMessages): string {
  const m = messages.settings
  const { value } = setting
  if (value === null) {
    if (setting.key === 'model') return m.cliDefault
    if (setting.key === 'ci.checks') return m.allChecks
    return m.notSet
  }
  if (value.kind === 'text') return oneLine(value.text)
  if (value.kind === 'number') return String(value.value)
  if (value.kind === 'flag') return value.on ? m.on : m.off
  if (value.kind === 'duration') return durationText(value.ms)
  return value.items.map(oneLine).join(', ')
}

function originColor(origin: SettingOrigin, { colors }: Theme): string | undefined {
  if (origin === 'repository') return colors.accent
  if (origin === 'global') return colors.info
  return colors.dim
}
