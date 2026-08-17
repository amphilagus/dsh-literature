/**
 * Local literature database backed by `node:sqlite`: paper/journal CRUD,
 * FTS5 full-text search with a substring fallback, filter queries, backup,
 * import/export, and aggregate stats.
 * @module @amphilagus/dsh-literature/db
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { SCHEMA_DDL, SCHEMA_VERSION } from './schema.ts'
import type {
  CuratedPaperRecord,
  CuratedPaperView,
  DatabaseStats,
  ImportResult,
  JournalInput,
  JournalRecord,
  PaperFilters,
  PaperInput,
  PaperRecord,
  SearchFinding,
  SearchLogRecord,
  TrackingPlanInput,
  TrackingPlanRecord,
  CurationRelevance,
} from './types.ts'

const DEFAULT_SOURCE = 'manual'

function nowIso(): string {
  return new Date().toISOString()
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Convert a sqlite row into the requested record shape (or null when absent). */
function asRecord<T>(row: Record<string, SQLOutputValue> | undefined): T | null {
  return row === undefined ? null : row as unknown as T
}

/** Drop explicitly-undefined keys so exactOptionalPropertyTypes stays honest. */
function definedEntries<T extends object>(input: T): Partial<T> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value
  }
  return result as Partial<T>
}

/** FTS5 phrase-AND query: one quoted phrase per word token, AND-ed together. */
export function toFtsQuery(raw: string): string {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu) ?? []
  if (tokens.length === 0) return '""'
  return tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' ')
}

/** SQL LIKE pattern escaping for user-provided substrings. */
export function escapeLike(raw: string): string {
  return raw.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

export class LiteratureDatabase {
  /** Absolute path of the SQLite file. */
  readonly path: string
  private db: DatabaseSync | undefined

  constructor(path: string) {
    this.path = resolve(path)
  }

  /** Directory owning the database file (the plugin's sandbox grant root). */
  get dataDir(): string {
    return dirname(this.path)
  }

  get isOpen(): boolean {
    return this.db !== undefined
  }

  /** Create the parent directory, open the file, and ensure the schema. */
  open(): void {
    if (this.db !== undefined) return
    mkdirSync(this.dataDir, { recursive: true })
    const db = new DatabaseSync(this.path)
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      for (const statement of SCHEMA_DDL) db.exec(statement)
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(SCHEMA_VERSION))
    } catch (error) {
      db.close()
      throw error
    }
    this.db = db
  }

  close(): void {
    this.db?.close()
    this.db = undefined
  }

  private requireDb(): DatabaseSync {
    if (this.db === undefined) throw new Error('literature database is not open')
    return this.db
  }

  // ---------------------------------------------------------------- papers

  /** Insert or update one paper. Returns true on success. */
  upsertPaper(input: PaperInput): boolean {
    const db = this.requireDb()
    const existing = this.getPaper(input.doi)
    const base: PaperRecord = existing ?? {
      doi: input.doi,
      title: input.title,
      authors: '[]',
      journal: null,
      issn: null,
      eissn: null,
      publication_date: null,
      year: null,
      abstract: null,
      url: null,
      source: DEFAULT_SOURCE,
      is_open_access: 0,
      citation_count: 0,
      impact_factor: null,
      cas_partition: null,
      is_sci: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    const record: PaperRecord = {
      ...base,
      ...definedEntries(input),
      doi: input.doi,
      title: input.title,
      updated_at: nowIso(),
    }
    db.prepare(
      `INSERT INTO papers (
         doi, title, authors, journal, issn, eissn, publication_date, year,
         abstract, url, source, is_open_access, citation_count, impact_factor,
         cas_partition, is_sci, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(doi) DO UPDATE SET
         title = excluded.title,
         authors = excluded.authors,
         journal = excluded.journal,
         issn = excluded.issn,
         eissn = excluded.eissn,
         publication_date = excluded.publication_date,
         year = excluded.year,
         abstract = excluded.abstract,
         url = excluded.url,
         source = excluded.source,
         is_open_access = excluded.is_open_access,
         citation_count = excluded.citation_count,
         impact_factor = excluded.impact_factor,
         cas_partition = excluded.cas_partition,
         is_sci = excluded.is_sci,
         updated_at = excluded.updated_at`,
    ).run(
      record.doi,
      record.title,
      record.authors,
      record.journal,
      record.issn,
      record.eissn,
      record.publication_date,
      record.year,
      record.abstract,
      record.url,
      record.source,
      record.is_open_access,
      record.citation_count,
      record.impact_factor,
      record.cas_partition,
      record.is_sci,
      record.created_at,
      record.updated_at,
    )
    return true
  }

  getPaper(doi: string): PaperRecord | null {
    const row = this.requireDb().prepare('SELECT * FROM papers WHERE doi = ?').get(doi)
    return asRecord<PaperRecord>(row)
  }

  deletePaper(doi: string): boolean {
    const result = this.requireDb().prepare('DELETE FROM papers WHERE doi = ?').run(doi)
    return result.changes > 0
  }

  countPapers(): number {
    const row = this.requireDb().prepare('SELECT COUNT(*) AS count FROM papers').get()
    return Number((row as { count: SQLOutputValue } | undefined)?.count ?? 0)
  }

  /**
   * Filtered paper search. A non-empty `query` runs an FTS5 match ordered by
   * relevance; when FTS5 returns nothing (strict phrase-AND) or the query is
   * CJK, it falls back to a substring scan over title/abstract/journal/authors.
   */
  searchPapers(filters: PaperFilters = {}): PaperRecord[] {
    const db = this.requireDb()
    const limit = clampInteger(filters.limit ?? 20, 1, 100)
    const offset = clampInteger(filters.offset ?? 0, 0, 1_000_000)
    const query = filters.query?.trim() ?? ''
    const { where, params } = buildFilterClause(filters)
    const useFts = query.length > 0 && !CJK.test(query)

    if (useFts) {
      const conditions = ['papers_fts MATCH ?', ...where]
      const matchParams: SQLInputValue[] = [toFtsQuery(query), ...params]
      const rows = db.prepare(
        `SELECT p.* FROM papers p
         JOIN papers_fts ON papers_fts.rowid = p.rowid
         WHERE ${conditions.join(' AND ')}
         ORDER BY bm25(papers_fts)
         LIMIT ? OFFSET ?`,
      ).all(...matchParams, limit, offset)
      const papers = rows as unknown as PaperRecord[]
      if (papers.length > 0) return papers
    }
    return this.substringSearchPapers(query, filters, limit, offset)
  }

  /** Substring scan used as the FTS5 fallback and for CJK queries. */
  private substringSearchPapers(query: string, filters: PaperFilters, limit: number, offset: number): PaperRecord[] {
    const db = this.requireDb()
    const { where, params } = buildFilterClause(filters)
    const whereSql = [...where].join(' AND ')
    const like = `%${escapeLike(query)}%`
    const sql = `SELECT * FROM papers p
      WHERE (p.title LIKE ? ESCAPE '\\' OR p.abstract LIKE ? ESCAPE '\\' OR p.journal LIKE ? ESCAPE '\\' OR p.authors LIKE ? ESCAPE '\\')
      ${whereSql.length > 0 ? `AND ${whereSql}` : ''}
      ORDER BY p.year DESC, p.created_at DESC
      LIMIT ? OFFSET ?`
    const rows = db.prepare(sql).all(like, like, like, like, ...params, limit, offset)
    return rows as unknown as PaperRecord[]
  }

  // --------------------------------------------------------------- journals

  upsertJournal(input: JournalInput): boolean {
    const db = this.requireDb()
    const existing = this.getJournal(input.id)
    const base: JournalRecord = existing ?? {
      id: input.id,
      journal_title: input.journal_title,
      abbreviated_title: null,
      issn: null,
      eissn: null,
      impact_factor: null,
      impact_factor_5year: null,
      cas_partition: null,
      cas_discipline: null,
      is_sci: 0,
      web_of_science_categories: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    const record: JournalRecord = {
      ...base,
      ...definedEntries(input),
      id: input.id,
      journal_title: input.journal_title,
      updated_at: nowIso(),
    }
    db.prepare(
      `INSERT INTO journals (
         id, journal_title, abbreviated_title, issn, eissn, impact_factor,
         impact_factor_5year, cas_partition, cas_discipline, is_sci,
         web_of_science_categories, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         journal_title = excluded.journal_title,
         abbreviated_title = excluded.abbreviated_title,
         issn = excluded.issn,
         eissn = excluded.eissn,
         impact_factor = excluded.impact_factor,
         impact_factor_5year = excluded.impact_factor_5year,
         cas_partition = excluded.cas_partition,
         cas_discipline = excluded.cas_discipline,
         is_sci = excluded.is_sci,
         web_of_science_categories = excluded.web_of_science_categories,
         updated_at = excluded.updated_at`,
    ).run(
      record.id,
      record.journal_title,
      record.abbreviated_title,
      record.issn,
      record.eissn,
      record.impact_factor,
      record.impact_factor_5year,
      record.cas_partition,
      record.cas_discipline,
      record.is_sci,
      record.web_of_science_categories,
      record.created_at,
      record.updated_at,
    )
    return true
  }

  getJournal(id: string): JournalRecord | null {
    const row = this.requireDb().prepare('SELECT * FROM journals WHERE id = ?').get(id)
    return asRecord<JournalRecord>(row)
  }

  deleteJournal(id: string): boolean {
    const result = this.requireDb().prepare('DELETE FROM journals WHERE id = ?').run(id)
    return result.changes > 0
  }

  countJournals(): number {
    const row = this.requireDb().prepare('SELECT COUNT(*) AS count FROM journals').get()
    return Number((row as { count: SQLOutputValue } | undefined)?.count ?? 0)
  }

  /** Substring search over journal titles (top matches first). */
  searchJournals(query: string, limit = 20): JournalRecord[] {
    const db = this.requireDb()
    const like = `%${escapeLike(query)}%`
    const rows = db.prepare(
      `SELECT * FROM journals WHERE journal_title LIKE ? ESCAPE '\\'
       ORDER BY impact_factor DESC, journal_title ASC
       LIMIT ?`,
    ).all(like, clampInteger(limit, 1, 100))
    return rows as unknown as JournalRecord[]
  }

  // -------------------------------------------------- literature tracking

  /** Insert or update one tracking plan. */
  upsertTrackingPlan(input: TrackingPlanInput & { id: string }): boolean {
    const db = this.requireDb()
    const existing = this.getTrackingPlan(input.id)
    const base: TrackingPlanRecord = existing ?? {
      id: input.id,
      name: input.name,
      kind: input.kind,
      journal_whitelist: null,
      orcid: null,
      time_window_days: 7,
      search_interval_days: 7,
      enabled: 1,
      notes: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    const record: TrackingPlanRecord = {
      ...base,
      ...definedEntries(input),
      id: input.id,
      name: input.name,
      kind: input.kind,
      updated_at: nowIso(),
    }
    db.prepare(
      `INSERT INTO tracking_plans (
         id, name, kind, journal_whitelist, orcid, time_window_days,
         search_interval_days, enabled, notes, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         kind = excluded.kind,
         journal_whitelist = excluded.journal_whitelist,
         orcid = excluded.orcid,
         time_window_days = excluded.time_window_days,
         search_interval_days = excluded.search_interval_days,
         enabled = excluded.enabled,
         notes = excluded.notes,
         updated_at = excluded.updated_at`,
    ).run(
      record.id,
      record.name,
      record.kind,
      record.journal_whitelist,
      record.orcid,
      record.time_window_days,
      record.search_interval_days,
      record.enabled,
      record.notes,
      record.created_at,
      record.updated_at,
    )
    return true
  }

  getTrackingPlan(idOrName: string): TrackingPlanRecord | null {
    const row = this.requireDb().prepare(
      'SELECT * FROM tracking_plans WHERE id = ? OR name = ?',
    ).get(idOrName, idOrName)
    return asRecord<TrackingPlanRecord>(row)
  }

  listTrackingPlans(): TrackingPlanRecord[] {
    const rows = this.requireDb().prepare(
      'SELECT * FROM tracking_plans ORDER BY enabled DESC, name ASC',
    ).all()
    return rows as unknown as TrackingPlanRecord[]
  }

  deleteTrackingPlan(idOrName: string): boolean {
    const result = this.requireDb().prepare(
      'DELETE FROM tracking_plans WHERE id = ? OR name = ?',
    ).run(idOrName, idOrName)
    return result.changes > 0
  }

  /**
   * Curate one paper into a direction (新库). `(plan_id, unique_id)` is unique:
   * the same paper may exist under several directions but only once per
   * direction. Returns the created record, or null when it is already curated
   * for this plan.
   */
  curatePaper(planId: string, uniqueId: string, relevance: CurationRelevance, note: string | null): CuratedPaperRecord | null {
    const db = this.requireDb()
    const existing = this.getCuratedPaper(planId, uniqueId)
    if (existing !== null) return null
    const result = db.prepare(
      `INSERT INTO curated_papers (plan_id, unique_id, relevance, note)
       VALUES (?, ?, ?, ?)`,
    ).run(planId, uniqueId, relevance, note)
    return {
      id: Number(result.lastInsertRowid),
      plan_id: planId,
      unique_id: uniqueId,
      relevance,
      note,
      added_at: nowIso(),
    }
  }

  getCuratedPaper(planId: string, uniqueId: string): CuratedPaperRecord | null {
    const row = this.requireDb().prepare(
      'SELECT * FROM curated_papers WHERE plan_id = ? AND unique_id = ?',
    ).get(planId, uniqueId)
    return asRecord<CuratedPaperRecord>(row)
  }

  /** Curated entries of one direction joined with their source papers. */
  listCuratedPapers(planId: string, limit = 100): CuratedPaperView[] {
    const rows = this.requireDb().prepare(
      `SELECT c.*, p.title, p.journal, p.url, p.publication_date
       FROM curated_papers c
       LEFT JOIN papers p ON p.doi = c.unique_id
       WHERE c.plan_id = ?
       ORDER BY c.added_at DESC, c.id DESC
       LIMIT ?`,
    ).all(planId, clampInteger(limit, 1, 500))
    return rows as unknown as CuratedPaperView[]
  }

  /** All unique ids already curated under one direction (first-pass dedupe). */
  curatedUniqueIds(planId: string): Set<string> {
    const rows = this.requireDb().prepare(
      'SELECT unique_id FROM curated_papers WHERE plan_id = ?',
    ).all(planId)
    return new Set((rows as unknown as { unique_id: string }[]).map(row => row.unique_id))
  }

  countCuratedPapers(): number {
    const row = this.requireDb().prepare('SELECT COUNT(*) AS count FROM curated_papers').get()
    return Number((row as { count: SQLOutputValue } | undefined)?.count ?? 0)
  }

  /** Start one search log; returns its id. */
  startSearchLog(planId: string, windowStart: string, windowEnd: string): number {
    const result = this.requireDb().prepare(
      `INSERT INTO search_logs (plan_id, started_at, window_start, window_end, status)
       VALUES (?, ?, ?, ?, 'running')`,
    ).run(planId, nowIso(), windowStart, windowEnd)
    return Number(result.lastInsertRowid)
  }

  getSearchLog(id: number): SearchLogRecord | null {
    const row = this.requireDb().prepare('SELECT * FROM search_logs WHERE id = ?').get(id)
    return asRecord<SearchLogRecord>(row)
  }

  listSearchLogs(planId: string | undefined, limit = 50): SearchLogRecord[] {
    const db = this.requireDb()
    const rows = planId === undefined
      ? db.prepare('SELECT * FROM search_logs ORDER BY id DESC LIMIT ?').all(clampInteger(limit, 1, 200))
      : db.prepare('SELECT * FROM search_logs WHERE plan_id = ? ORDER BY id DESC LIMIT ?').all(planId, clampInteger(limit, 1, 200))
    return rows as unknown as SearchLogRecord[]
  }

  /**
   * Complete one search log (搜索记录表的填写终点). Returns false when the
   * log does not exist or is already done.
   */
  completeSearchLog(id: number, findings: SearchFinding[], summary: string | null): boolean {
    const db = this.requireDb()
    const existing = this.getSearchLog(id)
    if (existing === null || existing.status === 'done') return false
    db.prepare(
      `UPDATE search_logs SET status = 'done', findings = ?, summary = ?, completed_at = ?
       WHERE id = ?`,
    ).run(JSON.stringify(findings), summary, nowIso(), id)
    return true
  }

  // -------------------------------------------------------- batch and admin

  /**
   * Import a batch of papers in one transaction. Invalid records (missing
   * or empty doi/title) are counted as failed without aborting the batch.
   */
  importPapers(records: PaperInput[]): ImportResult {
    const db = this.requireDb()
    const result: ImportResult = { imported: 0, skipped: 0, failed: 0, errors: [] }
    db.exec('BEGIN IMMEDIATE')
    try {
      let index = 0
      for (const record of records) {
        index += 1
        const doi = record.doi?.trim() ?? ''
        const title = record.title?.trim() ?? ''
        if (doi.length === 0 || title.length === 0) {
          result.failed += 1
          result.errors.push(`record ${index}: doi and title are required`)
          continue
        }
        const existed = this.getPaper(doi) !== null
        this.upsertPaper(record)
        if (existed) result.skipped += 1
        else result.imported += 1
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return result
  }

  /** Copy the database to `destination` (a fresh consistent file). */
  backup(destination: string): string {
    const db = this.requireDb()
    const target = resolve(destination)
    mkdirSync(dirname(target), { recursive: true })
    db.exec(`VACUUM INTO ${quoteSqlString(target)}`)
    return target
  }

  /** Write all papers and journals to `destination` as one JSON document. */
  exportToJson(destination: string): { path: string; count: number } {
    const db = this.requireDb()
    const target = resolve(destination)
    mkdirSync(dirname(target), { recursive: true })
    const papers = db.prepare('SELECT * FROM papers ORDER BY year DESC, created_at DESC').all()
    const journals = db.prepare('SELECT * FROM journals ORDER BY journal_title ASC').all()
    const document = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowIso(),
      papers,
      journals,
    }
    writeFileSync(target, JSON.stringify(document, null, 2), 'utf8')
    return { path: target, count: (papers as unknown[]).length }
  }

  vacuum(): void {
    const db = this.requireDb()
    // Merge any WAL frames into the main file first; plain VACUUM alone
    // leaves them stranded in literature.db-wal, so readers that only see
    // the main file (or a copy of it) would miss recent rows.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.exec('VACUUM')
  }

  stats(): DatabaseStats {
    const db = this.requireDb()
    const row = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM papers) AS papers,
         (SELECT COUNT(*) FROM journals) AS journals,
         (SELECT MIN(year) FROM papers) AS min_year,
         (SELECT MAX(year) FROM papers) AS max_year`,
    ).get()
    const values = (row ?? {}) as { papers?: SQLOutputValue; journals?: SQLOutputValue; min_year?: SQLOutputValue; max_year?: SQLOutputValue }
    let sizeBytes = 0
    try {
      sizeBytes = statSync(this.path).size
    } catch {
      sizeBytes = 0
    }
    return {
      dbPath: this.path,
      sizeBytes,
      schemaVersion: SCHEMA_VERSION,
      paperCount: Number(values.papers ?? 0),
      journalCount: Number(values.journals ?? 0),
      earliestYear: values.min_year === null || values.min_year === undefined ? null : Number(values.min_year),
      latestYear: values.max_year === null || values.max_year === undefined ? null : Number(values.max_year),
    }
  }
}

// --------------------------------------------------------------- helpers

function quoteSqlString(raw: string): string {
  return `'${raw.replaceAll("'", "''")}'`
}

/**
 * WHERE fragments for the non-query filters shared by the FTS and substring
 * paths. `params` pairs with `where` by index.
 */
function buildFilterClause(filters: PaperFilters): { where: string[]; params: SQLInputValue[] } {
  const where: string[] = []
  const params: SQLInputValue[] = []
  if (filters.journal !== undefined && filters.journal.trim().length > 0) {
    where.push(`p.journal LIKE ? ESCAPE '\\'`)
    params.push(`%${escapeLike(filters.journal.trim())}%`)
  }
  if (filters.source !== undefined && filters.source.trim().length > 0) {
    where.push('p.source = ?')
    params.push(filters.source)
  }
  if (filters.fromYear !== undefined) {
    where.push('p.year >= ?')
    params.push(filters.fromYear)
  }
  if (filters.toYear !== undefined) {
    where.push('p.year <= ?')
    params.push(filters.toYear)
  }
  if (filters.openAccess === true) {
    where.push('p.is_open_access = 1')
  }
  if (filters.minCitations !== undefined) {
    where.push('p.citation_count >= ?')
    params.push(filters.minCitations)
  }
  if (filters.casPartition !== undefined) {
    where.push('p.cas_partition = ?')
    params.push(filters.casPartition)
  }
  return { where, params }
}
