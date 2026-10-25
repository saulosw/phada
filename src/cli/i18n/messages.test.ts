import { describe, expect, it } from 'vitest'
import { messagesFor } from './messages.js'

describe('messagesFor', () => {
  it.each(['pt', 'pt-BR', 'PT-pt'])('uses Portuguese for %s', (language) => {
    expect(messagesFor(language).summary).toBe('Resumo')
  })

  it.each(['es', 'es-MX', 'es-419', 'ES-ar'])('uses Spanish for %s', (language) => {
    expect(messagesFor(language).summary).toBe('Resumen')
  })

  it.each([undefined, 'en', 'en-US', 'fr', 'zh-Hant-TW'])(
    'falls back to English for %s',
    (language) => {
      expect(messagesFor(language).summary).toBe('Summary')
    },
  )
})

describe.each([
  ['en', 'Phada review', 'Generated with Phada'],
  ['pt', 'Revisão do Phada', 'Gerado com Phada'],
  ['es', 'Revisión de Phada', 'Generado con Phada'],
])('the %s catalog', (language, heading, generated) => {
  const messages = messagesFor(language)

  it('puts the butterfly on the outer side of the name Phada', () => {
    const butterfly = (text: string) => (text.startsWith('Phada') ? `🦋 ${text}` : `${text} 🦋`)
    expect(messages.github.heading).toBe(butterfly(heading))
    expect(messages.github.generatedWith).toBe(butterfly(generated))
  })

  it('writes the score reason from the focus of the score', () => {
    expect(messages.scoreReason(undefined)).not.toBe('')
    expect(
      messages.scoreReason({ severity: 'P1', count: 2, locations: ['a.ts:1', 'b.ts:2'] }),
    ).toContain('P1')
    expect(
      messages.scoreReason({ severity: 'P1', count: 2, locations: ['a.ts:1', 'b.ts:2'] }),
    ).toContain('(a.ts:1, b.ts:2)')
  })
})

describe('Portuguese texts', () => {
  const pt = messagesFor('pt-BR')

  it('agree in number', () => {
    expect(pt.scoreReason(undefined)).toBe('nenhum problema encontrado')
    expect(pt.scoreReason({ severity: 'P0', count: 1, locations: ['a.ts:1'] })).toBe(
      '1 problema P0 (a.ts:1)',
    )
    expect(pt.moreFiles(1)).toBe('1 arquivo a mais')
    expect(pt.moreFiles(2)).toBe('2 arquivos a mais')
    expect(pt.github.stillOpenCount(1)).toBe('1 ainda pendente de revisões anteriores')
    expect(pt.github.inlineComments('1 P1, 1 P2', 2)).toBe(
      '**1 P1, 1 P2 como comentários na linha**',
    )
    expect(pt.terminal.findingCount(1)).toBe('1 problema')
  })

  it('describe drops and the verification', () => {
    expect(
      pt.dropped({ invalid: 1, belowFloor: 0, outsideDiff: 2, duplicate: 1, rejected: 1 }),
    ).toBe('5 descartados (1 rejeitado pela verificação, 2 fora do diff, 1 duplicado, 1 inválido)')
    expect(
      pt.verification({ candidates: 2, confirmed: 0, unverified: 2, rejected: [], durationMs: 1 }),
    ).toBe('não verificado (2 sem resposta)')
  })

  it('says only the earlier findings remain open', () => {
    expect(pt.github.onlyStillOpen(3, 'a1b2c3d')).toBe(
      'Nenhum problema novo em a1b2c3d. 3 comentários do Phada de revisões anteriores continuam abertos: resolva-os para receber uma revisão completa deste commit.',
    )
  })
})

describe('Spanish texts', () => {
  const es = messagesFor('es-MX')

  it('agree in number', () => {
    expect(es.scoreReason(undefined)).toBe('no se encontraron problemas')
    expect(es.scoreReason({ severity: 'P0', count: 1, locations: ['a.ts:1'] })).toBe(
      '1 hallazgo P0 (a.ts:1)',
    )
    expect(es.scoreReason({ severity: 'P1', count: 2, locations: ['a.ts:1', 'b.ts:2'] })).toBe(
      '2 hallazgos P1 (a.ts:1, b.ts:2)',
    )
    expect(es.moreFiles(1)).toBe('1 archivo más')
    expect(es.moreFiles(2)).toBe('2 archivos más')
    expect(es.github.stillOpenCount(1)).toBe('1 pendiente de revisiones anteriores')
    expect(es.github.stillOpenCount(2)).toBe('2 pendientes de revisiones anteriores')
    expect(es.github.inlineComments('1 P1', 1)).toBe('**1 P1 como comentario en línea**')
    expect(es.github.inlineComments('1 P1, 1 P2', 2)).toBe(
      '**1 P1, 1 P2 como comentarios en línea**',
    )
    expect(es.github.filesTruncated(1)).toBe('Tabla de archivos truncada (1 archivo).')
    expect(es.terminal.findingCount(1)).toBe('1 hallazgo')
    expect(es.terminal.findingCount(3)).toBe('3 hallazgos')
  })

  it('names the state of the pull request', () => {
    expect(es.terminal.state('open', false)).toBe('abierta')
    expect(es.terminal.state('closed', true)).toBe('cerrada, borrador')
  })

  it('describe drops and the verification', () => {
    expect(
      es.dropped({ invalid: 1, belowFloor: 0, outsideDiff: 2, duplicate: 1, rejected: 1 }),
    ).toBe(
      '5 descartados (1 rechazado por la verificación, 2 fuera del diff, 1 duplicado, 1 inválido)',
    )
    expect(
      es.dropped({ invalid: 0, belowFloor: 1, outsideDiff: 0, duplicate: 0, rejected: 0 }),
    ).toBe('1 descartado (1 por debajo de la confianza 50)')
    expect(
      es.verification({ candidates: 2, confirmed: 0, unverified: 2, rejected: [], durationMs: 1 }),
    ).toBe('no verificado (2 sin respuesta)')
    expect(
      es.verification({ candidates: 3, confirmed: 2, unverified: 1, rejected: [], durationMs: 1 }),
    ).toBe('verificado, 1 sin respuesta')
  })

  it('says only the earlier findings remain open', () => {
    expect(es.github.onlyStillOpen(1, 'a1b2c3d')).toBe(
      'No hay problemas nuevos en a1b2c3d. 1 comentario de Phada de revisiones anteriores sigue abierto: resuélvelo para recibir una revisión completa de este commit.',
    )
    expect(es.github.onlyStillOpen(3, 'a1b2c3d')).toBe(
      'No hay problemas nuevos en a1b2c3d. 3 comentarios de Phada de revisiones anteriores siguen abiertos: resuélvelos para recibir una revisión completa de este commit.',
    )
  })

  it('counts the fixed threads', () => {
    expect(es.github.fixedThreads(1, 'a1b2c3d')).toBe(
      '1 comentario de revisiones anteriores está corregido en a1b2c3d.',
    )
    expect(es.github.fixedThreads(2, 'a1b2c3d')).toBe(
      '2 comentarios de revisiones anteriores están corregidos en a1b2c3d.',
    )
  })
})
