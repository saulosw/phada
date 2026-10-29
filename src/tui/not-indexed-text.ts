import type { NotIndexed } from '../app/local-repository.js'
import type { ConnectionMessages } from './i18n/messages.js'
import { oneLine } from './text-fit.js'

export function notIndexedText(why: NotIndexed, c: ConnectionMessages): string {
  switch (why.reason) {
    case 'other-version':
      return c.why['other-version'](
        why.found.phadaVersion === null ? null : oneLine(why.found.phadaVersion),
      )
    case 'unreadable':
    case 'mirror-unreadable':
      return c.why[why.reason](oneLine(why.error))
    default:
      return c.why[why.reason]
  }
}
