type WarningTarget = Pick<NodeJS.Process, 'emitWarning'>

const SQLITE_WARNING = /^SQLite\b/

export function suppressSqliteWarning(target: WarningTarget): void {
  const emit = target.emitWarning.bind(target) as (...args: unknown[]) => void
  target.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    if (isSqliteWarning(warning, rest[0])) return
    emit(warning, ...rest)
  }) as WarningTarget['emitWarning']
}

function isSqliteWarning(warning: unknown, typeOrOptions: unknown): boolean {
  if (warning instanceof Error) {
    return warning.name === 'ExperimentalWarning' && SQLITE_WARNING.test(warning.message)
  }
  const type =
    typeof typeOrOptions === 'string'
      ? typeOrOptions
      : (typeOrOptions as { type?: unknown } | undefined)?.type
  return (
    type === 'ExperimentalWarning' && typeof warning === 'string' && SQLITE_WARNING.test(warning)
  )
}
