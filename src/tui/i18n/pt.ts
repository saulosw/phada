import type { UiMessages } from './messages.js'

export const portuguese: UiMessages = {
  screens: {
    home: { full: 'Início', short: 'Início' },
    repositories: { full: 'Repositórios', short: 'Repos' },
    rules: { full: 'Regras', short: 'Regras' },
    reviews: { full: 'Reviews', short: 'Reviews' },
    queue: { full: 'Fila', short: 'Fila' },
    automation: { full: 'Automações', short: 'Auto' },
    provider: { full: 'Provider', short: 'IA' },
    learnings: { full: 'Aprendizados', short: 'Aprend.' },
  },
  keys: {
    screens: 'telas',
    cycle: 'tela seguinte ou anterior',
    jump: 'ir para uma tela pelo número',
    palette: 'ir para',
    help: 'ajuda',
    back: 'voltar',
    quit: 'sair',
    more: 'mais',
    select: 'escolher',
    open: 'abrir',
    close: 'fechar',
    refresh: 'atualizar',
  },
  help: { title: 'Teclas', global: 'Em qualquer tela' },
  palette: { title: 'Ir para', empty: 'Nenhuma tela com esse nome.' },
  tooSmall: (columns, rows) =>
    `O terminal tem ${columns}×${rows}. O Phada precisa de pelo menos 80×24: aumente a janela.`,
  tooSmallHint: 'q sair',
  placeholder: 'Esta tela ainda não está pronta.',
  home: { tagline: 'Revise pull requests com a IA que você já usa.' },
  loading: 'Carregando…',
  failed: (message) => `Não foi possível carregar: ${message}`,
  time: {
    now: 'agora',
    soon: 'a qualquer momento',
    ago: (span) => `há ${span}`,
    in: (span, estimated) => `em ${estimated ? '~' : ''}${span}`,
  },
  list: { range: (first, last, total) => `${first}–${last} de ${total}` },
}
