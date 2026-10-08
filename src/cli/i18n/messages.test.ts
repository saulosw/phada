import { describe, expect, it } from 'vitest'
import { messagesFor } from './messages.js'

describe('messagesFor', () => {
  it.each(['pt', 'pt-BR', 'PT-pt'])('uses Portuguese for %s', (language) => {
    expect(messagesFor(language).summary).toBe('Resumo')
  })

  it.each([undefined, 'en', 'en-US', 'es', 'zh-Hant-TW'])(
    'falls back to English for %s',
    (language) => {
      expect(messagesFor(language).summary).toBe('Summary')
    },
  )
})

describe.each([
  ['en', 'Phada review', 'Generated with Phada'],
  ['pt', 'Revisão do Phada', 'Gerado com Phada'],
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
