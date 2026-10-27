import { Text } from 'ink'
import type { ReactNode } from 'react'
import { textWidth } from './tab-layout.js'
import { wrapText } from './text-fit.js'

export type LabeledRow = readonly [label: string, value: string | undefined]

export function labeledLines(
  rows: readonly LabeledRow[],
  width: number,
  labelColor?: string,
): ReactNode[] {
  const shown = rows.filter((row): row is readonly [string, string] => row[1] !== undefined)
  const labelWidth = Math.max(0, ...shown.map(([label]) => textWidth(label)))
  const indent = ' '.repeat(labelWidth + 2)
  return shown.flatMap(([label, value]) =>
    wrapText(value, width - labelWidth - 2).map((line, index) =>
      index === 0 ? (
        <Text>
          <Text color={labelColor}>{label.padEnd(labelWidth)}</Text>
          {'  '}
          {line}
        </Text>
      ) : (
        <Text>
          {indent}
          {line}
        </Text>
      ),
    ),
  )
}
