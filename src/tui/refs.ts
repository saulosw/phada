import type { RunTarget } from '../app/run-target.js'
import { runPlace, runTarget } from '../app/run-target.js'
import { oneLine } from './text-fit.js'

const SHORT_SHA_LENGTH = 7

export function pullRef(repo: string, number: number): string {
  return oneLine(`${repo}#${number}`)
}

export function shortSha(sha: string): string {
  return oneLine(sha.slice(0, SHORT_SHA_LENGTH))
}

export function runRef(run: RunTarget): string {
  return oneLine(runTarget(run))
}

export function runPlaceRef(run: RunTarget): string {
  return oneLine(runPlace(run))
}
