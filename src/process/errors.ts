export class CommandError extends Error {
  override readonly name: string = 'CommandError'
  readonly command: string

  constructor(command: string, message: string) {
    super(message)
    this.command = command
  }
}

export class CommandNotFoundError extends CommandError {
  override readonly name = 'CommandNotFoundError'

  constructor(command: string) {
    super(command, `Command "${command}" was not found.`)
  }
}

export class CommandTimeoutError extends CommandError {
  override readonly name = 'CommandTimeoutError'
  readonly timeoutMs: number

  constructor(command: string, timeoutMs: number) {
    super(
      command,
      `Command "${command}" did not finish within ${timeoutMs / 1000}s and was stopped.`,
    )
    this.timeoutMs = timeoutMs
  }
}

export class CommandOutputTooLargeError extends CommandError {
  override readonly name = 'CommandOutputTooLargeError'
  readonly maxOutputLength: number

  constructor(command: string, maxOutputLength: number) {
    super(
      command,
      `Command "${command}" wrote more than ${maxOutputLength} characters and was stopped.`,
    )
    this.maxOutputLength = maxOutputLength
  }
}
