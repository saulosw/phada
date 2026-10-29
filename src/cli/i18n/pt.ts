import { CONFIDENCE_FLOOR } from '../../review/select-findings.js'
import { joinNames } from '../name-list.js'
import type { CiNames, Messages } from './messages.js'

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`
}

function ciNames({ count, shown }: CiNames): string {
  return `(${joinNames(shown, count, (more) => `${more} a mais`)})`
}

export const portuguese: Messages = {
  scoreLabels: {
    5: 'pronto para merge',
    4: 'pequenos ajustes',
    3: 'problemas de implementação',
    2: 'bugs significativos',
    1: 'problemas críticos',
    0: 'problemas críticos',
  },
  scoreReason: (focus) =>
    focus === undefined
      ? 'nenhum problema encontrado'
      : `${count(focus.count, 'problema', 'problemas')} ${focus.severity} (${focus.locations.join(', ')})`,
  confidence: 'confiança',
  fix: 'Correção sugerida',
  basedOn: 'Com base em',
  leftOut: 'Fora do review',
  rule: 'regra',
  skill: 'skill',
  ciCheck: 'check de CI',
  summary: 'Resumo',
  files: 'Arquivos',
  fileColumns: ['Arquivo', 'Alteração', 'Problemas'],
  moreFiles: (value) => count(value, 'arquivo a mais', 'arquivos a mais'),
  worthChecking: (minConfidence) => `Vale verificar (confiança abaixo de ${minConfidence})`,
  moreItems: (value) => `… (+${value} a mais)`,
  debt: 'Débito do repositório',
  debtNote:
    'Problemas que já estão no repositório e que esta mudança não causa; não contam na nota.',
  dropped: (dropped) => {
    const reasons: ReadonlyArray<readonly [number, string]> = [
      [dropped.rejected, `${count(dropped.rejected, 'rejeitado', 'rejeitados')} pela verificação`],
      [dropped.outsideDiff, `${dropped.outsideDiff} fora do diff`],
      [dropped.duplicate, count(dropped.duplicate, 'duplicado', 'duplicados')],
      [dropped.belowFloor, `${dropped.belowFloor} abaixo da confiança ${CONFIDENCE_FLOOR}`],
      [dropped.invalid, count(dropped.invalid, 'inválido', 'inválidos')],
      [dropped.debt ?? 0, `${dropped.debt ?? 0} débito do repositório`],
    ]
    const shown = reasons.filter(([value]) => value > 0)
    const total = shown.reduce((sum, [value]) => sum + value, 0)
    return total === 0
      ? ''
      : `${count(total, 'descartado', 'descartados')} (${shown.map(([, text]) => text).join(', ')})`
  },
  verification: ({ candidates, unverified }) => {
    if (unverified > 0 && unverified === candidates) {
      return `não verificado (${unverified} sem resposta)`
    }
    return unverified > 0 ? `verificado, ${unverified} sem resposta` : 'verificado'
  },
  terminal: {
    reviewOf: 'Revisão de',
    head: 'commit',
    state: (state, draft) => {
      const name = state === 'open' ? 'aberta' : 'fechada'
      return draft ? `${name}, rascunho` : name
    },
    score: 'Nota de confiança',
    findings: 'Problemas',
    severity: {
      P0: 'P0 · Corrigir antes do merge',
      P1: 'P1 · Deve ser corrigido',
      P2: 'P2 · Vale considerar',
    },
    findingCount: (value) => count(value, 'problema', 'problemas'),
    worthCheckingCount: (value) => `${value} para verificar`,
    closeToCut: 'rente ao corte',
    closeToCutCount: (value) => `${value} rente ao corte`,
    tokens: (input, output) => `${input} de entrada / ${output} de saída`,
  },
  github: {
    skillBody: (skill) => `Revisão da skill ${skill}`,
    inlineComments: (bySeverity, value) =>
      `**${bySeverity} como ${value === 1 ? 'comentário na linha' : 'comentários na linha'}**`,
    stillOpenCount: (value) =>
      `${count(value, 'ainda pendente', 'ainda pendentes')} de revisões anteriores`,
    stillOpen: 'Ainda pendentes de revisões anteriores',
    filesTruncated: (value) =>
      `Tabela de arquivos truncada (${count(value, 'arquivo', 'arquivos')}).`,
    truncated: '… (truncado)',
    allIgnoredTitle: 'nada para revisar',
    allIgnored: (sha) =>
      `Todos os arquivos alterados em ${sha} ficaram fora do review, então a IA não olhou este commit.`,
    onlyStillOpenTitle: 'nenhum problema novo',
    onlyStillOpen: (value, sha) =>
      value === 1
        ? `Nenhum problema novo em ${sha}. 1 comentário de revisões anteriores continua aberto: resolva-o para receber uma revisão completa deste commit.`
        : `Nenhum problema novo em ${sha}. ${value} comentários de revisões anteriores continuam abertos: resolva-os para receber uma revisão completa deste commit.`,
    preview: (index, total, place) =>
      `===== Comentário na linha ${index}/${total} · ${place} =====`,
    fixedThreads: (value, sha) =>
      value === 1
        ? `1 comentário de revisões anteriores está corrigido em ${sha}.`
        : `${value} comentários de revisões anteriores estão corrigidos em ${sha}.`,
    resolvedReply: (sha, reason) => `Corrigido em \`${sha}\`: ${reason}`,
    ci: (state, total, failing, pending) => {
      const checks = count(total, 'check', 'checks')
      if (state === 'passing') {
        return total === 1 ? 'CI: 1 check passando' : `CI: todos os ${checks} passando`
      }
      if (state === 'pending') {
        return `CI: ${pending.count} de ${checks} ${pending.count === 1 ? 'pendente' : 'pendentes'} ${ciNames(pending)}`
      }
      const waiting =
        pending.count === 0 ? '' : ` · ${count(pending.count, 'pendente', 'pendentes')}`
      return `CI: ${failing.count} de ${checks} falhando ${ciNames(failing)}${waiting}`
    },
  },
}
