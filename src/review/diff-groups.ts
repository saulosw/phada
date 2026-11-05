import { parseDiffFiles } from './diff-lines.js'
import type { DiffGroup } from './types.js'

export const GROUP_FROM_BYTES = 30_000
export const GROUP_TARGET_BYTES = 20_000
export const MAX_GROUPS = 6

const DATA_EXTENSIONS: ReadonlySet<string> = new Set([
  'json',
  'lock',
  'csv',
  'tsv',
  'svg',
  'snap',
  'txt',
  'md',
  'map',
])
const HEADER_LINES = 5
const GENERATED_HEADER = /@generated|Code generated .* DO NOT EDIT/
const UTF8 = new TextEncoder()

interface Section {
  path: string
  text: string
  bytes: number
  code: boolean
}

interface Bucket {
  files: Section[]
  bytes: number
  single: boolean
}

export function planDiffGroups(
  diff: string,
  generated: readonly string[] = [],
): DiffGroup[] | undefined {
  const sections = diffSections(diff, new Set(generated))
  const code = sections.filter((section) => section.code)
  if (sum(code) < GROUP_FROM_BYTES) return undefined
  const buckets = capped(split('', code))
  if (buckets.length < 2) return undefined
  const order = new Map(sections.map(({ path }, index) => [path, index]))
  const attached = buckets.map((bucket) => ({ bucket, others: [] as Section[] }))
  for (const section of sections.filter((section) => !section.code)) {
    const nearest = nearestOf(
      directoryOf(section.path),
      attached.map(({ bucket }) => bucket),
    )
    attached[nearest]?.others.push(section)
  }
  const labels = attached.map(({ bucket }) => labelOf(bucket))
  return attached.map(({ bucket, others }, index) => ({
    label: numbered(labels, index),
    files: [...bucket.files, ...others]
      .sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0))
      .map(({ path }) => path),
    bytes: bucket.bytes,
    link: bucket.single ? 'single' : 'directory',
  }))
}

export function groupDiff(diff: string, files: readonly string[]): string {
  const wanted = new Set(files)
  return sectionsOf(diff)
    .filter(({ path }) => wanted.has(path))
    .map(({ text }) => text)
    .join('')
}

function sectionsOf(diff: string): { path: string; text: string }[] {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index)
  return starts.map((start, index) => {
    const text = diff.slice(start, starts[index + 1] ?? diff.length)
    return { path: parseDiffFiles(text)[0]?.path ?? '', text }
  })
}

function diffSections(diff: string, generated: ReadonlySet<string>): Section[] {
  return sectionsOf(diff).map(({ path, text }) => {
    const file = parseDiffFiles(text)[0]
    const header = [...(file?.newText ?? new Map()).entries()].some(
      ([line, { text: content }]) => line <= HEADER_LINES && GENERATED_HEADER.test(content),
    )
    const data = DATA_EXTENSIONS.has(extensionOf(path))
    return {
      path,
      text,
      bytes: UTF8.encode(text).length,
      code:
        file?.status !== 'binary' &&
        file?.status !== 'deleted' &&
        !data &&
        !generated.has(path) &&
        !header,
    }
  })
}

function split(directory: string, files: readonly Section[]): Bucket[] {
  if (sum(files) <= GROUP_TARGET_BYTES) return [bucketOf(files)]
  const children = new Map<string, Section[]>()
  const loose: Section[] = []
  for (const file of files) {
    const rest = directory === '' ? file.path : file.path.slice(directory.length + 1)
    const slash = rest.indexOf('/')
    if (slash === -1) {
      loose.push(file)
      continue
    }
    const child = directory === '' ? rest.slice(0, slash) : `${directory}/${rest.slice(0, slash)}`
    children.set(child, [...(children.get(child) ?? []), file])
  }
  const parts = [
    ...[...children.entries()].map(([child, inside]) => ({
      key: child,
      buckets: split(child, inside),
    })),
    ...loose.map((file) => ({ key: file.path, buckets: [bucketOf([file])] })),
  ]
    .sort((a, b) => a.key.localeCompare(b.key))
    .flatMap(({ buckets }) => buckets)
  return packed(parts)
}

function packed(buckets: readonly Bucket[]): Bucket[] {
  const result: Bucket[] = []
  for (const bucket of buckets) {
    const last = result.at(-1)
    if (
      last !== undefined &&
      !last.single &&
      !bucket.single &&
      last.bytes + bucket.bytes <= GROUP_TARGET_BYTES
    ) {
      result[result.length - 1] = joined(last, bucket)
    } else {
      result.push(bucket)
    }
  }
  return result
}

function capped(buckets: Bucket[]): Bucket[] {
  const result = [...buckets]
  while (result.length > MAX_GROUPS) {
    const smallest = result.reduce(
      (best, bucket, index) => ((result[best]?.bytes ?? 0) <= bucket.bytes ? best : index),
      0,
    )
    const [taken] = result.splice(smallest, 1)
    if (taken === undefined) break
    const nearest = nearestOf(directoryOfBucket(taken), result)
    const target = result[nearest]
    if (target !== undefined) result[nearest] = joined(target, taken)
  }
  return result
}

function nearestOf(directory: string, buckets: readonly Bucket[]): number {
  let best = 0
  let bestShared = -1
  for (const [index, bucket] of buckets.entries()) {
    const shared = sharedDepth(directory, directoryOfBucket(bucket))
    const current = buckets[best]
    if (
      shared > bestShared ||
      (shared === bestShared && current !== undefined && bucket.bytes < current.bytes)
    ) {
      best = index
      bestShared = shared
    }
  }
  return best
}

function numbered(labels: readonly string[], index: number): string {
  const label = labels[index] ?? ''
  if (labels.filter((other) => other === label).length < 2) return label
  const part = labels.slice(0, index + 1).filter((other) => other === label).length
  return `${label} (part ${part})`
}

function bucketOf(files: readonly Section[]): Bucket {
  const bytes = sum(files)
  return { files: [...files], bytes, single: files.length === 1 && bytes > GROUP_TARGET_BYTES }
}

function joined(a: Bucket, b: Bucket): Bucket {
  return { files: [...a.files, ...b.files], bytes: a.bytes + b.bytes, single: false }
}

function labelOf(bucket: Bucket): string {
  const only = bucket.files[0]
  if (bucket.single && only !== undefined) return only.path
  const directory = directoryOfBucket(bucket)
  if (directory !== '') return directory
  const tops = new Map<string, Section[]>()
  for (const file of bucket.files) {
    const top = file.path.includes('/') ? file.path.slice(0, file.path.indexOf('/')) : ''
    tops.set(top, [...(tops.get(top) ?? []), file])
  }
  if (tops.size < 2) return '.'
  return [...tops.entries()]
    .map(([top, files]) => (top === '' ? '.' : directoryOfBucket(bucketOf(files))))
    .join(' + ')
}

function directoryOfBucket(bucket: Bucket): string {
  const directories = bucket.files.map(({ path }) => directoryOf(path).split('/'))
  const first = directories[0] ?? []
  let depth = 0
  while (
    depth < first.length &&
    first[depth] !== '' &&
    directories.every((parts) => parts[depth] === first[depth])
  ) {
    depth++
  }
  return first.slice(0, depth).join('/')
}

function sharedDepth(a: string, b: string): number {
  const left = a === '' ? [] : a.split('/')
  const right = b === '' ? [] : b.split('/')
  let depth = 0
  while (depth < left.length && left[depth] === right[depth]) depth++
  return depth
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

function sum(files: readonly { bytes: number }[]): number {
  return files.reduce((total, { bytes }) => total + bytes, 0)
}

export interface ChangedFile {
  path: string
  added: number
  removed: number
}

export function changedFiles(diff: string): ChangedFile[] {
  return sectionsOf(diff).map(({ path, text }) => {
    const lines = text.split('\n')
    const hunk = lines.findIndex((line) => line.startsWith('@@'))
    const body = hunk === -1 ? [] : lines.slice(hunk)
    return {
      path,
      added: body.filter((line) => line.startsWith('+')).length,
      removed: body.filter((line) => line.startsWith('-')).length,
    }
  })
}
