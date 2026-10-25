import type { UiMessages } from './messages.js'

export const spanish: UiMessages = {
  screens: {
    home: { full: 'Inicio', short: 'Inicio' },
    repositories: { full: 'Repositorios', short: 'Repos' },
    rules: { full: 'Reglas', short: 'Reglas' },
    reviews: { full: 'Revisiones', short: 'Revis.' },
    queue: { full: 'Cola', short: 'Cola' },
    automation: { full: 'Automatización', short: 'Auto' },
    provider: { full: 'Proveedor', short: 'IA' },
    learnings: { full: 'Aprendizajes', short: 'Aprend.' },
  },
  keys: {
    screens: 'pantallas',
    cycle: 'pantalla siguiente o anterior',
    jump: 'ir a una pantalla por su número',
    palette: 'ir a',
    help: 'ayuda',
    back: 'volver',
    quit: 'salir',
    more: 'más',
    select: 'elegir',
    open: 'abrir',
    close: 'cerrar',
    refresh: 'actualizar',
  },
  help: { title: 'Teclas', global: 'En cualquier pantalla' },
  palette: { title: 'Ir a', empty: 'Ninguna pantalla con ese nombre.' },
  tooSmall: (columns, rows) =>
    `La terminal mide ${columns}×${rows}. Phada necesita al menos 80×24: agranda la ventana.`,
  tooSmallHint: 'q salir',
  placeholder: 'Esta pantalla todavía no está lista.',
  home: { tagline: 'Revisa pull requests con la IA que ya usas.' },
  loading: 'Cargando…',
  failed: (message) => `No se pudo cargar: ${message}`,
  time: {
    now: 'ahora',
    soon: 'en cualquier momento',
    ago: (span) => `hace ${span}`,
    in: (span, estimated) => `en ${estimated ? '~' : ''}${span}`,
  },
}
