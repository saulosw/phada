import { describe, expect, it } from 'vitest'
import { bytesText, durationText, modelSizeText } from './units.js'

describe('durationText', () => {
  it.each([
    [0, '0s'],
    [45_000, '45s'],
    [90_000, '1m30s'],
    [300_000, '5m'],
    [3_600_000, '1h'],
    [5_400_000, '1h30m'],
    [86_400_000, '24h'],
  ])('writes %d ms as %s', (ms, text) => {
    expect(durationText(ms)).toBe(text)
  })
})

describe('bytesText', () => {
  it.each([
    [512, '512 B'],
    [2048, '2.0 KB'],
    [12_900_000, '12.3 MB'],
    [3_221_225_472, '3.0 GB'],
  ])('writes %d bytes as %s', (bytes, text) => {
    expect(bytesText(bytes)).toBe(text)
  })
})

describe('modelSizeText', () => {
  it.each([
    [900, '900 B'],
    [274_000_000, '274 MB'],
    [1_170_768_296, '1.2 GB'],
    [4_683_087_332, '4.7 GB'],
  ])('writes %d bytes in the decimal units Ollama shows: %s', (bytes, text) => {
    expect(modelSizeText(bytes)).toBe(text)
  })
})
