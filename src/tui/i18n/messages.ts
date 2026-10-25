import { english } from './en.js'
import { spanish } from './es.js'
import { portuguese } from './pt.js'

export type ScreenId =
  'home' | 'repositories' | 'rules' | 'reviews' | 'queue' | 'automation' | 'provider' | 'learnings'

export interface ScreenTitle {
  full: string
  short: string
}

export interface UiMessages {
  screens: Readonly<Record<ScreenId, ScreenTitle>>
  keys: {
    screens: string
    cycle: string
    jump: string
    palette: string
    help: string
    back: string
    quit: string
    more: string
    select: string
    open: string
    close: string
    refresh: string
  }
  help: { title: string; global: string }
  palette: { title: string; empty: string }
  tooSmall(columns: number, rows: number): string
  tooSmallHint: string
  placeholder: string
  home: { tagline: string }
  loading: string
  failed(message: string): string
}

const CATALOGS: Readonly<Record<string, UiMessages>> = {
  en: english,
  pt: portuguese,
  es: spanish,
}

export function uiMessagesFor(language: string | undefined): UiMessages {
  const base = language?.split('-', 1)[0]?.toLowerCase() ?? 'en'
  return CATALOGS[base] ?? english
}
