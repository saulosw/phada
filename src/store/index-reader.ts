import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import type { Language } from '../repo-map/languages.js'
import type { HeritageRelation, ImportKind, SymbolKind } from '../repo-map/types.js'

export interface IndexedFile {
  path: string
  blobId: number
  language: Language
}

export interface SymbolRow {
  id: number
  blobId: number
  kind: SymbolKind
  name: string
  parentId?: number
  container?: string
  startLine: number
  endLine: number
  exported: boolean
  signature: string
}

export interface CallRow {
  blobId: number
  callerId?: number
  name: string
  qualifier?: string
  line: number
  constructs: boolean
}

export interface ReferenceRow {
  blobId: number
  ownerId?: number
  name: string
  qualifier?: string
  line: number
}

export interface ImportRow {
  blobId: number
  module: string
  name?: string
  alias?: string
  kind: ImportKind
  line: number
}

export interface ExportRow {
  blobId: number
  name: string
  local?: string
  module?: string
  line: number
}

export interface HeritageRow {
  symbolId: number
  name: string
  relation: HeritageRelation
}

export interface IndexReader {
  readonly commit: string
  files(): ReadonlyMap<string, IndexedFile>
  paths(): ReadonlySet<string>
  pathsOfBlob(blobId: number): readonly string[]
  symbolsOfBlob(blobId: number): readonly SymbolRow[]
  callsOfBlob(blobId: number): readonly CallRow[]
  referencesOfBlob(blobId: number): readonly ReferenceRow[]
  importsOfBlob(blobId: number): readonly ImportRow[]
  exportsOfBlob(blobId: number): readonly ExportRow[]
  heritageOfBlob(blobId: number): readonly HeritageRow[]
  symbolsNamed(name: string, options?: { ignoreCase?: boolean }): readonly SymbolRow[]
  callsNamed(name: string, limit: number): readonly CallRow[]
  referencesNamed(name: string, limit: number): readonly ReferenceRow[]
  importsNamed(name: string): readonly ImportRow[]
  heritageNamed(name: string): readonly HeritageRow[]
  callersOfNames(names: readonly string[], limit: number): readonly number[]
  symbol(id: number): SymbolRow | undefined
}

type Row = Record<string, SQLInputValue>

const IN_COMMIT =
  "blob_id in (select blob_id from snapshot_file where commit_sha = ? and status = 'indexed' and blob_id is not null)"
const SYMBOL_COLUMNS =
  'id, blob_id, kind, name, parent_id, container, start_line, end_line, exported, signature'
const CALL_COLUMNS = 'blob_id, caller_id, name, qualifier, line, constructs'
const REFERENCE_COLUMNS = 'blob_id, owner_id, name, qualifier, line'
const IMPORT_COLUMNS = 'blob_id, module, name, alias, kind, line'

export class SqliteIndexReader implements IndexReader {
  readonly commit: string
  readonly #db: DatabaseSync
  readonly #statements = new Map<string, StatementSync>()
  #files: Map<string, IndexedFile> | undefined
  #paths: Set<string> | undefined
  #blobPaths: Map<number, string[]> | undefined

  constructor(db: DatabaseSync, commit: string) {
    this.#db = db
    this.commit = commit
  }

  files(): ReadonlyMap<string, IndexedFile> {
    this.#load()
    return this.#files ?? new Map()
  }

  paths(): ReadonlySet<string> {
    this.#load()
    return this.#paths ?? new Set()
  }

  pathsOfBlob(blobId: number): readonly string[] {
    this.#load()
    return this.#blobPaths?.get(blobId) ?? []
  }

  symbolsOfBlob(blobId: number): readonly SymbolRow[] {
    return this.#all(
      `select ${SYMBOL_COLUMNS} from symbol where blob_id = ? order by id`,
      blobId,
    ).map(toSymbol)
  }

  callsOfBlob(blobId: number): readonly CallRow[] {
    return this.#all(
      `select ${CALL_COLUMNS} from call_site where blob_id = ? order by line`,
      blobId,
    ).map(toCall)
  }

  referencesOfBlob(blobId: number): readonly ReferenceRow[] {
    return this.#all(
      `select ${REFERENCE_COLUMNS} from reference where blob_id = ? order by line`,
      blobId,
    ).map(toReference)
  }

  importsOfBlob(blobId: number): readonly ImportRow[] {
    return this.#all(
      `select ${IMPORT_COLUMNS} from import_item where blob_id = ? order by line`,
      blobId,
    ).map(toImport)
  }

  exportsOfBlob(blobId: number): readonly ExportRow[] {
    return this.#all(
      'select blob_id, name, local_name, module, line from export_item where blob_id = ? order by line',
      blobId,
    ).map(toExport)
  }

  heritageOfBlob(blobId: number): readonly HeritageRow[] {
    return this.#all(
      'select h.symbol_id, h.name, h.relation from heritage h join symbol s on s.id = h.symbol_id where s.blob_id = ?',
      blobId,
    ).map(toHeritage)
  }

  symbolsNamed(name: string, options: { ignoreCase?: boolean } = {}): readonly SymbolRow[] {
    const match = options.ignoreCase === true ? 'lower(name) = lower(?)' : 'name = ?'
    return this.#all(
      `select ${SYMBOL_COLUMNS} from symbol where ${match} and ${IN_COMMIT} order by id`,
      name,
      this.commit,
    ).map(toSymbol)
  }

  callsNamed(name: string, limit: number): readonly CallRow[] {
    return this.#all(
      `select ${CALL_COLUMNS} from call_site where name = ? and ${IN_COMMIT} limit ?`,
      name,
      this.commit,
      limit,
    ).map(toCall)
  }

  referencesNamed(name: string, limit: number): readonly ReferenceRow[] {
    return this.#all(
      `select ${REFERENCE_COLUMNS} from reference where name = ? and ${IN_COMMIT} limit ?`,
      name,
      this.commit,
      limit,
    ).map(toReference)
  }

  importsNamed(name: string): readonly ImportRow[] {
    return this.#all(
      `select ${IMPORT_COLUMNS} from import_item where name = ? and ${IN_COMMIT}`,
      name,
      this.commit,
    ).map(toImport)
  }

  heritageNamed(name: string): readonly HeritageRow[] {
    return this.#all(
      `select h.symbol_id, h.name, h.relation from heritage h join symbol s on s.id = h.symbol_id where h.name = ? and s.${IN_COMMIT}`,
      name,
      this.commit,
    ).map(toHeritage)
  }

  callersOfNames(names: readonly string[], limit: number): readonly number[] {
    if (names.length === 0) return []
    return this.#all(
      `select distinct caller_id from call_site where name in (${names.map(() => '?').join(',')}) and caller_id is not null and ${IN_COMMIT} limit ?`,
      ...names,
      this.commit,
      limit,
    ).map((row) => Number(row.caller_id))
  }

  symbol(id: number): SymbolRow | undefined {
    const [row] = this.#all(`select ${SYMBOL_COLUMNS} from symbol where id = ?`, id)
    return row === undefined ? undefined : toSymbol(row)
  }

  #load(): void {
    if (this.#files !== undefined) return
    const files = new Map<string, IndexedFile>()
    const paths = new Set<string>()
    const blobPaths = new Map<number, string[]>()
    for (const row of this.#all(
      'select path, blob_id, language, status from snapshot_file where commit_sha = ?',
      this.commit,
    )) {
      const path = String(row.path)
      paths.add(path)
      if (row.status !== 'indexed' || row.blob_id === null) continue
      const blobId = Number(row.blob_id)
      files.set(path, { path, blobId, language: row.language as Language })
      blobPaths.set(blobId, [...(blobPaths.get(blobId) ?? []), path])
    }
    this.#files = files
    this.#paths = paths
    this.#blobPaths = blobPaths
  }

  #all(sql: string, ...values: SQLInputValue[]): Row[] {
    let statement = this.#statements.get(sql)
    if (statement === undefined) {
      statement = this.#db.prepare(sql)
      this.#statements.set(sql, statement)
    }
    return statement.all(...values) as Row[]
  }
}

function optionalNumber(value: SQLInputValue | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value)
}

function optionalText(value: SQLInputValue | undefined): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
}

function toSymbol(row: Row): SymbolRow {
  const parentId = optionalNumber(row.parent_id)
  const container = optionalText(row.container)
  return {
    id: Number(row.id),
    blobId: Number(row.blob_id),
    kind: row.kind as SymbolKind,
    name: String(row.name),
    ...(parentId === undefined ? {} : { parentId }),
    ...(container === undefined ? {} : { container }),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    exported: Number(row.exported) === 1,
    signature: String(row.signature),
  }
}

function toCall(row: Row): CallRow {
  const callerId = optionalNumber(row.caller_id)
  const qualifier = optionalText(row.qualifier)
  return {
    blobId: Number(row.blob_id),
    ...(callerId === undefined ? {} : { callerId }),
    name: String(row.name),
    ...(qualifier === undefined ? {} : { qualifier }),
    line: Number(row.line),
    constructs: Number(row.constructs) === 1,
  }
}

function toReference(row: Row): ReferenceRow {
  const ownerId = optionalNumber(row.owner_id)
  const qualifier = optionalText(row.qualifier)
  return {
    blobId: Number(row.blob_id),
    ...(ownerId === undefined ? {} : { ownerId }),
    name: String(row.name),
    ...(qualifier === undefined ? {} : { qualifier }),
    line: Number(row.line),
  }
}

function toImport(row: Row): ImportRow {
  const name = optionalText(row.name)
  const alias = optionalText(row.alias)
  return {
    blobId: Number(row.blob_id),
    module: String(row.module),
    ...(name === undefined ? {} : { name }),
    ...(alias === undefined ? {} : { alias }),
    kind: row.kind as ImportKind,
    line: Number(row.line),
  }
}

function toExport(row: Row): ExportRow {
  const local = optionalText(row.local_name)
  const module = optionalText(row.module)
  return {
    blobId: Number(row.blob_id),
    name: String(row.name),
    ...(local === undefined ? {} : { local }),
    ...(module === undefined ? {} : { module }),
    line: Number(row.line),
  }
}

function toHeritage(row: Row): HeritageRow {
  return {
    symbolId: Number(row.symbol_id),
    name: String(row.name),
    relation: row.relation as HeritageRelation,
  }
}
