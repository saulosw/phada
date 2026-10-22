import type { FieldValue, GhCommand, GhCommandInput } from './types.js'

interface FlagSpec {
  values: Record<string, string>
  bools: Record<string, string>
}

interface ParsedFlags {
  positional: string[]
  values: Map<string, string[]>
  ordered: { name: string; value: string }[]
  bools: Set<string>
}

const REPO = { '-R': 'repo', '--repo': 'repo' }
const JSON_FLAGS = {
  '--json': 'json',
  '-q': 'jq',
  '--jq': 'jq',
  '-t': 'template',
  '--template': 'template',
}
const LIST = {
  ...REPO,
  ...JSON_FLAGS,
  '-s': 'state',
  '--state': 'state',
  '-L': 'limit',
  '--limit': 'limit',
  '-S': 'search',
  '--search': 'search',
  '-A': 'author',
  '--author': 'author',
  '-l': 'label',
  '--label': 'label',
  '-B': 'base',
  '--base': 'base',
  '-H': 'head',
  '--head': 'head',
}
const BODY = { '-b': 'body', '--body': 'body', '-F': 'body-file', '--body-file': 'body-file' }

const SPECS: Record<string, FlagSpec> = {
  'pr view': {
    values: { ...REPO, ...JSON_FLAGS },
    bools: { '-c': 'comments', '--comments': 'comments' },
  },
  'pr diff': {
    values: { ...REPO, '--color': 'color' },
    bools: { '--name-only': 'name-only', '--patch': 'patch' },
  },
  'pr list': { values: LIST, bools: { '-d': 'draft', '--draft': 'draft' } },
  'pr comment': { values: { ...REPO, ...BODY }, bools: {} },
  'pr review': {
    values: { ...REPO, ...BODY },
    bools: {
      '-a': 'approve',
      '--approve': 'approve',
      '-c': 'comment',
      '--comment': 'comment',
      '-r': 'request-changes',
      '--request-changes': 'request-changes',
    },
  },
  'issue view': {
    values: { ...REPO, ...JSON_FLAGS },
    bools: { '-c': 'comments', '--comments': 'comments' },
  },
  'issue list': { values: LIST, bools: {} },
  'search prs': { values: LIST, bools: {} },
  'search issues': { values: LIST, bools: {} },
  'repo view': { values: JSON_FLAGS, bools: {} },
  api: {
    values: {
      '-X': 'method',
      '--method': 'method',
      '-f': 'raw-field',
      '--raw-field': 'raw-field',
      '-F': 'field',
      '--field': 'field',
      '--input': 'input',
      '-q': 'jq',
      '--jq': 'jq',
      '-H': 'header',
      '--header': 'header',
    },
    bools: {
      '--paginate': 'paginate',
      '--silent': 'silent',
      '-i': 'include',
      '--include': 'include',
    },
  },
  'auth status': {
    values: { '-h': 'hostname', '--hostname': 'hostname' },
    bools: { '-t': 'show-token', '--show-token': 'show-token' },
  },
}

export function parseGhCommand(argv: readonly string[], input: GhCommandInput): GhCommand {
  const [group = '', second = ''] = argv
  const name = group === 'api' ? 'api' : `${group} ${second}`
  const spec = SPECS[name]
  if (spec === undefined) return { kind: 'unsupported', sub: name.trim() }
  const flags = parseFlags(argv.slice(name === 'api' ? 1 : 2), spec)
  if (typeof flags === 'string') return { kind: 'unsupported', sub: `${name} ${flags}` }
  const one = (key: string) => flags.values.get(key)?.at(-1)
  const listing = {
    ...optional('repo', one('repo')),
    ...optional(
      'json',
      one('json')
        ?.split(',')
        .map((field) => field.trim())
        .filter(Boolean),
    ),
    ...optional('jq', one('jq')),
  }
  const target = flags.positional[0]
  switch (name) {
    case 'pr view':
      return {
        kind: 'pr-view',
        ...optional('target', target),
        ...listing,
        comments: flags.bools.has('comments'),
      }
    case 'pr diff':
      return {
        kind: 'pr-diff',
        ...optional('target', target),
        ...optional('repo', one('repo')),
        nameOnly: flags.bools.has('name-only'),
      }
    case 'pr list':
    case 'issue list':
      return {
        kind: name === 'pr list' ? 'pr-list' : 'issue-list',
        ...listing,
        ...optional('state', one('state')),
        ...optional('search', one('search')),
        ...optional('limit', limitOf(one('limit'))),
      }
    case 'pr comment':
      return {
        kind: 'pr-comment',
        ...optional('target', target),
        ...optional('repo', one('repo')),
        body: bodyOf(one('body'), one('body-file'), input),
      }
    case 'pr review':
      return {
        kind: 'pr-review',
        ...optional('target', target),
        ...optional('repo', one('repo')),
        event: flags.bools.has('approve')
          ? 'approve'
          : flags.bools.has('request-changes')
            ? 'request-changes'
            : 'comment',
        body: bodyOf(one('body'), one('body-file'), input),
      }
    case 'issue view':
      return {
        kind: 'issue-view',
        target: target ?? '',
        ...listing,
        comments: flags.bools.has('comments'),
      }
    case 'search prs':
    case 'search issues':
      return {
        kind: 'search',
        type: second === 'prs' ? 'prs' : 'issues',
        query: flags.positional.join(' '),
        ...listing,
        ...optional('limit', limitOf(one('limit'))),
      }
    case 'repo view':
      return { kind: 'repo-view', ...optional('target', target), ...listing }
    case 'auth status':
      return { kind: 'auth-status' }
    default:
      return apiCommand(flags, target ?? '', input)
  }
}

export function filesToRead(argv: readonly string[]): string[] {
  const files: string[] = []
  const isApi = argv[0] === 'api'
  const isBody = argv[0] === 'pr' && (argv[1] === 'comment' || argv[1] === 'review')
  if (!isApi && !isBody) return files
  const args = argv.slice(isApi ? 1 : 2)
  for (let index = 0; index < args.length; index++) {
    const [flag = '', inline] = splitInline(args[index] ?? '')
    const value = inline ?? args[index + 1]
    if (value === undefined) continue
    if (isBody && (flag === '-F' || flag === '--body-file')) {
      if (value !== '-') files.push(value)
    } else if (isApi && flag === '--input') {
      if (value !== '-') files.push(value)
    } else if (isApi && (flag === '-F' || flag === '--field')) {
      const at = value.indexOf('=@')
      if (at !== -1 && value.slice(at + 2) !== '-') files.push(value.slice(at + 2))
    } else {
      continue
    }
    if (inline === undefined) index++
  }
  return files
}

function apiCommand(flags: ParsedFlags, path: string, input: GhCommandInput): GhCommand {
  const fields: Record<string, FieldValue> = {}
  for (const { name, value } of flags.ordered) {
    if (name === 'raw-field' || name === 'field') setField(fields, value, name === 'field', input)
  }
  const inputArg = flags.values.get('input')?.at(-1)
  const inputValue = inputArg === undefined ? undefined : parseInput(fileOrStdin(inputArg, input))
  const hasBody = Object.keys(fields).length > 0 || inputArg !== undefined
  const method = (flags.values.get('method')?.at(-1) ?? (hasBody ? 'POST' : 'GET')).toUpperCase()
  const jq = flags.values.get('jq')?.at(-1)
  return {
    kind: 'api',
    method,
    path,
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
    ...(inputValue === undefined ? {} : { input: inputValue }),
    paginate: flags.bools.has('paginate'),
    ...(jq === undefined ? {} : { jq }),
  }
}

function setField(
  fields: Record<string, FieldValue>,
  pair: string,
  typed: boolean,
  input: GhCommandInput,
): void {
  const equals = pair.indexOf('=')
  if (equals === -1) return
  const key = pair.slice(0, equals)
  const raw = pair.slice(equals + 1)
  const value = typed ? typedValue(raw, input) : raw
  const nested = /^([^[\]]+)\[\]\[([^[\]]+)\]$/.exec(key)
  if (nested === null) {
    fields[key] = value
    return
  }
  const [, list = '', member = ''] = nested
  const items = Array.isArray(fields[list]) ? (fields[list] as FieldValue[]) : []
  const last = items.at(-1)
  if (isObject(last) && !(member in last)) last[member] = value
  else items.push({ [member]: value })
  fields[list] = items
}

function typedValue(raw: string, input: GhCommandInput): FieldValue {
  if (raw.startsWith('@')) return fileOrStdin(raw.slice(1), input)
  if (raw === 'true' || raw === 'false') return raw === 'true'
  if (raw === 'null') return null
  return /^-?\d+$/.test(raw) ? Number(raw) : raw
}

function parseInput(text: string): FieldValue {
  try {
    return JSON.parse(text) as FieldValue
  } catch {
    return text
  }
}

function bodyOf(body: string | undefined, file: string | undefined, input: GhCommandInput): string {
  if (body !== undefined) return body
  return file === undefined ? '' : fileOrStdin(file, input)
}

function fileOrStdin(path: string, input: GhCommandInput): string {
  return path === '-' ? (input.stdin ?? '') : (input.files[path] ?? '')
}

function parseFlags(args: readonly string[], spec: FlagSpec): ParsedFlags | string {
  const parsed: ParsedFlags = { positional: [], values: new Map(), ordered: [], bools: new Set() }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (!arg.startsWith('-') || arg === '-') {
      parsed.positional.push(arg)
      continue
    }
    const [flag = '', inline] = splitInline(arg)
    const valueName = spec.values[flag]
    const boolName = spec.bools[flag]
    if (valueName !== undefined) {
      const value = inline ?? args[++index]
      if (value === undefined) return flag
      parsed.values.set(valueName, [...(parsed.values.get(valueName) ?? []), value])
      parsed.ordered.push({ name: valueName, value })
    } else if (boolName !== undefined) {
      parsed.bools.add(boolName)
    } else {
      return flag
    }
  }
  return parsed
}

function splitInline(arg: string): [string, string | undefined] {
  if (!arg.startsWith('--')) return [arg, undefined]
  const equals = arg.indexOf('=')
  return equals === -1 ? [arg, undefined] : [arg.slice(0, equals), arg.slice(equals + 1)]
}

function limitOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const value = Number(text)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}

function isObject(value: FieldValue | undefined): value is { [key: string]: FieldValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
