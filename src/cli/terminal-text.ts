const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g

export function toTerminalText(text: string): string {
  return text.replace(CONTROL_CHARACTERS, '')
}
