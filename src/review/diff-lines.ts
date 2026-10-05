export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'binary'

export interface DiffFile {
  path: string
  status: DiffFileStatus
  lines: ReadonlySet<number>
}

type DiffLine =
  | { kind: 'numbered'; text: string; number: number }
  | { kind: 'unnumbered'; text: string }
  | { kind: 'header'; text: string }

interface FileDraft {
  gitPath: string | undefined
  oldPath: string | undefined
  newPath: string | undefined
  renamedTo: string | undefined
  status: DiffFileStatus
  lines: Set<number>
}

interface WalkState {
  file: FileDraft | undefined
  next: number
  oldLeft: number
  newLeft: number
}

const NUMBER_WIDTH = 5
const GIT_HEADER = 'diff --git '
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const DEV_NULL = '/dev/null'
const SIDE_PREFIX = /^[ab]\//
const SPACE_HINT = /\t.*$/s
const RELATIVE_PREFIX = /^(?:\.\/|[ab]\/|\/)/
const QUOTED_PART = /\\([0-7]{3})|\\(.)|([^\\]+)/gs
const C_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 }
const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder()

export function parseDiffFiles(diff: string): DiffFile[] {
  return walkDiff(diff).files.map((draft) => ({
    path: draft.renamedTo ?? draft.newPath ?? draft.oldPath ?? draft.gitPath ?? '',
    status: draft.status,
    lines: draft.lines,
  }))
}

export function annotateDiff(diff: string): string {
  return walkDiff(diff).lines.map(annotate).join('\n')
}

export function findDiffFile(path: string, files: readonly DiffFile[]): DiffFile | undefined {
  const exact = files.find((file) => file.path === path)
  if (exact !== undefined) return exact
  const relative = path.replace(RELATIVE_PREFIX, '')
  if (relative === '') return undefined
  const stripped = files.find((file) => file.path === relative)
  if (stripped !== undefined) return stripped
  const bySuffix = files.filter((file) => file.path.endsWith(`/${relative}`))
  return bySuffix.length === 1 ? bySuffix[0] : undefined
}

function walkDiff(diff: string): { lines: DiffLine[]; files: FileDraft[] } {
  const state: WalkState = { file: undefined, next: 0, oldLeft: 0, newLeft: 0 }
  const lines: DiffLine[] = []
  const files: FileDraft[] = []
  for (const text of diff === '' ? [] : diff.split('\n')) {
    lines.push(hunkLine(state, text) ?? headerLine(state, files, text))
  }
  return { lines, files }
}

function hunkLine(state: WalkState, text: string): DiffLine | undefined {
  if (state.oldLeft === 0 && state.newLeft === 0) return undefined
  const marker = text[0]
  if (marker === '\\') return { kind: 'unnumbered', text }
  if (marker === '-' && state.oldLeft > 0) {
    state.oldLeft--
    return { kind: 'unnumbered', text }
  }
  const added = marker === '+' && state.newLeft > 0
  const context = (marker === ' ' || marker === undefined) && state.oldLeft > 0 && state.newLeft > 0
  if (!added && !context) {
    state.oldLeft = 0
    state.newLeft = 0
    return undefined
  }
  if (context) state.oldLeft--
  state.newLeft--
  state.file?.lines.add(state.next)
  return { kind: 'numbered', text, number: state.next++ }
}

function headerLine(state: WalkState, files: FileDraft[], text: string): DiffLine {
  if (text.startsWith('\\')) return { kind: 'unnumbered', text }
  const hunk = HUNK_HEADER.exec(text)
  if (hunk !== null) {
    state.oldLeft = hunkCount(hunk[1])
    state.next = Number(hunk[2])
    state.newLeft = hunkCount(hunk[3])
  } else if (text.startsWith(GIT_HEADER)) {
    state.file = newDraft(text.slice(GIT_HEADER.length))
    files.push(state.file)
  } else if (state.file !== undefined) {
    readFileHeader(state.file, text)
  }
  return { kind: 'header', text }
}

function annotate(line: DiffLine): string {
  if (line.kind === 'numbered') return `${String(line.number).padStart(NUMBER_WIDTH)} ${line.text}`
  if (line.kind === 'unnumbered') return `${' '.repeat(NUMBER_WIDTH + 1)}${line.text}`
  return line.text
}

function newDraft(paths: string): FileDraft {
  return {
    gitPath: gitHeaderPath(paths),
    oldPath: undefined,
    newPath: undefined,
    renamedTo: undefined,
    status: 'modified',
    lines: new Set(),
  }
}

function readFileHeader(file: FileDraft, text: string): void {
  if (text.startsWith('new file mode')) file.status = 'added'
  else if (text.startsWith('deleted file mode')) file.status = 'deleted'
  else if (text.startsWith('Binary files ')) file.status = 'binary'
  else if (text.startsWith('rename to ')) {
    file.status = 'renamed'
    file.renamedTo = unquote(text.slice('rename to '.length))
  } else if (text.startsWith('--- ')) file.oldPath = sidePath(text.slice(4))
  else if (text.startsWith('+++ ')) file.newPath = sidePath(text.slice(4))
}

function gitHeaderPath(paths: string): string | undefined {
  const quoted = paths.lastIndexOf(' "b/')
  if (quoted !== -1) return sidePath(paths.slice(quoted + 1))
  const plain = paths.lastIndexOf(' b/')
  return plain === -1 ? undefined : sidePath(paths.slice(plain + 1))
}

function sidePath(value: string): string | undefined {
  const label = value.replace(SPACE_HINT, '')
  return label === DEV_NULL ? undefined : unquote(label).replace(SIDE_PREFIX, '')
}

function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
  const bytes: number[] = []
  for (const [, octal, escaped, plain] of value.slice(1, -1).matchAll(QUOTED_PART)) {
    if (octal !== undefined) bytes.push(Number.parseInt(octal, 8))
    else if (escaped !== undefined) bytes.push(C_ESCAPES[escaped] ?? escaped.charCodeAt(0))
    else if (plain !== undefined) bytes.push(...UTF8_ENCODER.encode(plain))
  }
  return UTF8_DECODER.decode(Uint8Array.from(bytes))
}

function hunkCount(value: string | undefined): number {
  return value === undefined ? 1 : Number(value)
}
