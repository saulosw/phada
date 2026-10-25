import type { UiMessages } from './messages.js'

export const english: UiMessages = {
  screens: {
    home: { full: 'Home', short: 'Home' },
    repositories: { full: 'Repositories', short: 'Repos' },
    rules: { full: 'Rules', short: 'Rules' },
    reviews: { full: 'Reviews', short: 'Reviews' },
    queue: { full: 'Queue', short: 'Queue' },
    automation: { full: 'Automation', short: 'Auto' },
    provider: { full: 'Provider', short: 'AI' },
    learnings: { full: 'Learnings', short: 'Learn' },
  },
  keys: {
    screens: 'screens',
    cycle: 'next or previous screen',
    jump: 'go to a screen by its number',
    palette: 'go to',
    help: 'help',
    back: 'back',
    quit: 'quit',
    more: 'more',
    select: 'select',
    open: 'open',
    close: 'close',
    refresh: 'refresh',
  },
  help: { title: 'Keys', global: 'Everywhere' },
  palette: { title: 'Go to', empty: 'No screen matches.' },
  tooSmall: (columns, rows) =>
    `The terminal is ${columns}×${rows}. Phada needs at least 80×24: make the window bigger.`,
  tooSmallHint: 'q quit',
  placeholder: 'This screen is not ready yet.',
  home: { tagline: 'Review pull requests with the AI you already use.' },
  loading: 'Loading…',
  failed: (message) => `Could not load: ${message}`,
}
