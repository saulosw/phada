import { CONFIDENCE_FLOOR } from '../../review/select-findings.js'
import { joinNames } from '../name-list.js'
import type { CiNames, Messages } from './messages.js'

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`
}

function ciNames({ count, shown }: CiNames): string {
  return `(${joinNames(shown, count, (more) => `${more} más`)})`
}

export const spanish: Messages = {
  scoreLabels: {
    5: 'listo para merge',
    4: 'pequeños ajustes',
    3: 'problemas de implementación',
    2: 'bugs significativos',
    1: 'problemas críticos',
    0: 'problemas críticos',
  },
  scoreReason: (focus) =>
    focus === undefined
      ? 'no se encontraron problemas'
      : `${count(focus.count, 'hallazgo', 'hallazgos')} ${focus.severity} (${focus.locations.join(', ')})`,
  confidence: 'confianza',
  fix: 'Corrección sugerida',
  basedOn: 'Basado en',
  leftOut: 'Fuera de la revisión',
  rule: 'regla',
  skill: 'skill',
  ciCheck: 'check de CI',
  summary: 'Resumen',
  files: 'Archivos',
  fileColumns: ['Archivo', 'Cambio', 'Hallazgos'],
  moreFiles: (value) => count(value, 'archivo más', 'archivos más'),
  worthChecking: (minConfidence) =>
    `Vale la pena revisar (confianza por debajo de ${minConfidence})`,
  moreItems: (value) => `… (+${value} más)`,
  dropped: (dropped) => {
    const reasons: ReadonlyArray<readonly [number, string]> = [
      [
        dropped.rejected,
        `${count(dropped.rejected, 'rechazado', 'rechazados')} por la verificación`,
      ],
      [dropped.outsideDiff, `${dropped.outsideDiff} fuera del diff`],
      [dropped.duplicate, count(dropped.duplicate, 'duplicado', 'duplicados')],
      [dropped.belowFloor, `${dropped.belowFloor} por debajo de la confianza ${CONFIDENCE_FLOOR}`],
      [dropped.invalid, count(dropped.invalid, 'inválido', 'inválidos')],
    ]
    const shown = reasons.filter(([value]) => value > 0)
    const total = shown.reduce((sum, [value]) => sum + value, 0)
    return total === 0
      ? ''
      : `${count(total, 'descartado', 'descartados')} (${shown.map(([, text]) => text).join(', ')})`
  },
  verification: ({ candidates, unverified }) => {
    if (unverified > 0 && unverified === candidates) {
      return `no verificado (${unverified} sin respuesta)`
    }
    return unverified > 0 ? `verificado, ${unverified} sin respuesta` : 'verificado'
  },
  terminal: {
    reviewOf: 'Revisión de',
    head: 'commit',
    state: (state, draft) => {
      const name = state === 'open' ? 'abierta' : 'cerrada'
      return draft ? `${name}, borrador` : name
    },
    score: 'Puntuación de confianza',
    findings: 'Hallazgos',
    severity: {
      P0: 'P0 · Corregir antes del merge',
      P1: 'P1 · Debería corregirse',
      P2: 'P2 · Vale la pena considerar',
    },
    findingCount: (value) => count(value, 'hallazgo', 'hallazgos'),
    worthCheckingCount: (value) => `${value} para revisar`,
    tokens: (input, output) => `${input} de entrada / ${output} de salida`,
  },
  github: {
    skillBody: (skill) => `Revisión de la skill ${skill}`,
    inlineComments: (bySeverity, value) =>
      `**${bySeverity} como ${value === 1 ? 'comentario en línea' : 'comentarios en línea'}**`,
    stillOpenCount: (value) =>
      `${count(value, 'pendiente', 'pendientes')} de revisiones anteriores`,
    stillOpen: 'Pendientes de revisiones anteriores',
    filesTruncated: (value) =>
      `Tabla de archivos truncada (${count(value, 'archivo', 'archivos')}).`,
    truncated: '… (truncado)',
    allIgnoredTitle: 'nada que revisar',
    allIgnored: (sha) =>
      `Todos los archivos modificados en ${sha} quedaron fuera de la revisión, así que la IA no analizó este commit.`,
    onlyStillOpenTitle: 'sin hallazgos nuevos',
    onlyStillOpen: (value, sha) =>
      value === 1
        ? `No hay problemas nuevos en ${sha}. 1 comentario de revisiones anteriores sigue abierto: resuélvelo para recibir una revisión completa de este commit.`
        : `No hay problemas nuevos en ${sha}. ${value} comentarios de revisiones anteriores siguen abiertos: resuélvelos para recibir una revisión completa de este commit.`,
    preview: (index, total, place) =>
      `===== Comentario en línea ${index}/${total} · ${place} =====`,
    fixedThreads: (value, sha) =>
      value === 1
        ? `1 comentario de revisiones anteriores está corregido en ${sha}.`
        : `${value} comentarios de revisiones anteriores están corregidos en ${sha}.`,
    resolvedReply: (sha, reason) => `Corregido en \`${sha}\`: ${reason}`,
    ci: (state, total, failing, pending) => {
      const checks = count(total, 'check', 'checks')
      if (state === 'passing') {
        return total === 1 ? 'CI: 1 check aprobado' : `CI: todos los ${checks} aprobados`
      }
      if (state === 'pending') {
        return `CI: ${pending.count} de ${checks} ${pending.count === 1 ? 'pendiente' : 'pendientes'} ${ciNames(pending)}`
      }
      const waiting =
        pending.count === 0 ? '' : ` · ${count(pending.count, 'pendiente', 'pendientes')}`
      return `CI: ${failing.count} de ${checks} ${failing.count === 1 ? 'fallido' : 'fallidos'} ${ciNames(failing)}${waiting}`
    },
  },
}
