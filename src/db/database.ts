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
  CuratedPaperView,
  DatabaseStats,
  ImportResult,
  JournalInput,
  JournalRecord,
  LibraryPaperInput,
  LibraryPaperRecord,
  PaperFilters,
  PaperInput,
  PaperRecord,
  SearchFinding,
  SearchLogRecord,
  TrackingPlanInput,
  TrackingPlanRecord,
  ResearcherProfileInput,
  ResearcherProfileRecord,
  ResearcherProfileStatus,
  CurationRelevance,
} from './types.ts'

const DEFAULT_SOURCE = 'manual'

/** Maximum rows kept in the `papers` search cache. Oldest `updated_at` dropped first. */
export const PAPER_CACHE_LIMIT = 2000

const RELEVANCE_RANK: Record<CurationRelevance, number> = {
  very_high: 4,
  high: 3,
  medium: 2,
  low: 1,
}

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
      db.exec('PRAGMA foreign_keys = ON')
      for (const statement of SCHEMA_DDL) db.exec(statement)
      const stored = readSchemaVersion(db)
      if (stored < 4) migrateV3CuratedToLibrary(db)
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
    this.prunePaperCache()
    return true
  }

  /** Drop oldest cache rows so `papers` never exceeds {@link PAPER_CACHE_LIMIT}. */
  prunePaperCache(): void {
    const extra = this.countPapers() - PAPER_CACHE_LIMIT
    if (extra <= 0) return
    this.requireDb().prepare(
      `DELETE FROM papers WHERE rowid IN (
         SELECT rowid FROM papers ORDER BY updated_at ASC, rowid ASC LIMIT ?
       )`,
    ).run(extra)
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

  // -------------------------------------------------- researcher profiles

  /** Insert or update one researcher profile. Same ORCID (same id) updates in place. */
  upsertResearcherProfile(input: ResearcherProfileInput): boolean {
    const db = this.requireDb()
    const existing = this.getResearcherProfileById(input.id)
    const base: ResearcherProfileRecord = existing ?? {
      id: input.id,
      display_name: input.display_name,
      family_name: null,
      given_name: null,
      name_zh: null,
      orcid: input.orcid,
      institution: null,
      homepage: null,
      email: null,
      research_areas: null,
      aliases: null,
      disambiguation_notes: null,
      plan_id: null,
      notes: null,
      status: 'active',
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    const record: ResearcherProfileRecord = {
      ...base,
      ...definedEntries(input),
      id: input.id,
      display_name: input.display_name,
      orcid: input.orcid,
      updated_at: nowIso(),
    }
    db.prepare(
      `INSERT INTO researcher_profiles (
         id, display_name, family_name, given_name, name_zh, orcid,
         institution, homepage, email, research_areas, aliases,
         disambiguation_notes, plan_id, notes, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         family_name = excluded.family_name,
         given_name = excluded.given_name,
         name_zh = excluded.name_zh,
         orcid = excluded.orcid,
         institution = excluded.institution,
         homepage = excluded.homepage,
         email = excluded.email,
         research_areas = excluded.research_areas,
         aliases = excluded.aliases,
         disambiguation_notes = excluded.disambiguation_notes,
         plan_id = excluded.plan_id,
         notes = excluded.notes,
         status = excluded.status,
         updated_at = excluded.updated_at`,
    ).run(
      record.id,
      record.display_name,
      record.family_name,
      record.given_name,
      record.name_zh,
      record.orcid,
      record.institution,
      record.homepage,
      record.email,
      record.research_areas,
      record.aliases,
      record.disambiguation_notes,
      record.plan_id,
      record.notes,
      record.status,
      record.created_at,
      record.updated_at,
    )
    return true
  }

  /** Unique lookup by primary key. */
  getResearcherProfileById(id: string): ResearcherProfileRecord | null {
    const row = this.requireDb().prepare(
      'SELECT * FROM researcher_profiles WHERE id = ?',
    ).get(id)
    return asRecord<ResearcherProfileRecord>(row)
  }

  /**
   * Resolve a profile key: id, then ORCID, then exact `display_name` / `name_zh`.
   * Name matches may return more than one row; callers must not take the first silently.
   */
  findResearcherProfiles(key: string): ResearcherProfileRecord[] {
    const db = this.requireDb()
    const byId = asRecord<ResearcherProfileRecord>(
      db.prepare('SELECT * FROM researcher_profiles WHERE id = ?').get(key),
    )
    if (byId !== null) return [byId]
    const byOrcid = asRecord<ResearcherProfileRecord>(
      db.prepare('SELECT * FROM researcher_profiles WHERE orcid = ?').get(key),
    )
    if (byOrcid !== null) return [byOrcid]
    const rows = db.prepare(
      'SELECT * FROM researcher_profiles WHERE display_name = ? OR name_zh = ?',
    ).all(key, key)
    return rows as unknown as ResearcherProfileRecord[]
  }

  listResearcherProfiles(status: ResearcherProfileStatus = 'active', limit = 50): ResearcherProfileRecord[] {
    const rows = this.requireDb().prepare(
      `SELECT * FROM researcher_profiles WHERE status = ?
       ORDER BY display_name ASC LIMIT ?`,
    ).all(status, clampInteger(limit, 1, 200))
    return rows as unknown as ResearcherProfileRecord[]
  }

  searchResearcherProfiles(
    query: string,
    status: ResearcherProfileStatus = 'active',
    limit = 50,
  ): ResearcherProfileRecord[] {
    const like = `%${escapeLike(query)}%`
    const rows = this.requireDb().prepare(
      `SELECT * FROM researcher_profiles
       WHERE status = ?
         AND (
           display_name LIKE ? ESCAPE '\\'
           OR IFNULL(name_zh, '') LIKE ? ESCAPE '\\'
           OR IFNULL(institution, '') LIKE ? ESCAPE '\\'
           OR IFNULL(research_areas, '') LIKE ? ESCAPE '\\'
           OR IFNULL(aliases, '') LIKE ? ESCAPE '\\'
         )
       ORDER BY display_name ASC LIMIT ?`,
    ).all(status, like, like, like, like, like, clampInteger(limit, 1, 200))
    return rows as unknown as ResearcherProfileRecord[]
  }

  deleteResearcherProfile(id: string): boolean {
    const result = this.requireDb().prepare(
      'DELETE FROM researcher_profiles WHERE id = ?',
    ).run(id)
    return result.changes > 0
  }

  /** Point an existing profile at a tracking plan. No-op when the ORCID is unknown. */
  linkProfilePlanByOrcid(orcid: string, planId: string): boolean {
    const result = this.requireDb().prepare(
      `UPDATE researcher_profiles SET plan_id = ?, updated_at = ? WHERE orcid = ?`,
    ).run(planId, nowIso(), orcid)
    return result.changes > 0
  }

  /**
   * Copy one cache row into the global library and drop it from the cache.
   * Returns the library row, or null when it is already curated. Throws when
   * the unique id is not in the papers cache.
   */
  curateFromCache(
    uniqueId: string,
    relevance: CurationRelevance,
    note: string | null,
    sourcePlanId: string | null = null,
  ): LibraryPaperRecord | null {
    const existing = this.getLibraryPaper(uniqueId)
    if (existing !== null) return null
    const cached = this.getPaper(uniqueId)
    if (cached === null) {
      throw new Error(`paper_not_in_legacy_db:${uniqueId}`)
    }
    this.upsertLibraryPaper({
      unique_id: uniqueId,
      title: cached.title,
      authors: cached.authors,
      journal: cached.journal,
      issn: cached.issn,
      eissn: cached.eissn,
      publication_date: cached.publication_date,
      year: cached.year,
      abstract: cached.abstract,
      url: cached.url,
      source: cached.source,
      is_open_access: cached.is_open_access,
      citation_count: cached.citation_count,
      impact_factor: cached.impact_factor,
      cas_partition: cached.cas_partition,
      is_sci: cached.is_sci,
      relevance,
      note,
      source_plan_id: sourcePlanId,
    })
    this.deletePaper(uniqueId)
    const created = this.getLibraryPaper(uniqueId)
    if (created === null) throw new Error(`library upsert vanished for ${uniqueId}`)
    return created
  }

  upsertLibraryPaper(input: LibraryPaperInput): boolean {
    const db = this.requireDb()
    const existing = this.getLibraryPaper(input.unique_id)
    const base: LibraryPaperRecord = existing ?? {
      unique_id: input.unique_id,
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
      relevance: input.relevance,
      note: null,
      source_plan_id: null,
      added_at: nowIso(),
      updated_at: nowIso(),
    }
    const record: LibraryPaperRecord = {
      ...base,
      ...definedEntries(input),
      unique_id: input.unique_id,
      title: input.title,
      relevance: input.relevance,
      updated_at: nowIso(),
    }
    db.prepare(
      `INSERT INTO library_papers (
         unique_id, title, authors, journal, issn, eissn, publication_date, year,
         abstract, url, source, is_open_access, citation_count, impact_factor,
         cas_partition, is_sci, relevance, note, source_plan_id, added_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(unique_id) DO UPDATE SET
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
         relevance = excluded.relevance,
         note = excluded.note,
         source_plan_id = excluded.source_plan_id,
         updated_at = excluded.updated_at`,
    ).run(
      record.unique_id,
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
      record.relevance,
      record.note,
      record.source_plan_id,
      record.added_at,
      record.updated_at,
    )
    return true
  }

  getLibraryPaper(uniqueId: string): LibraryPaperRecord | null {
    const row = this.requireDb().prepare('SELECT * FROM library_papers WHERE unique_id = ?').get(uniqueId)
    return asRecord<LibraryPaperRecord>(row)
  }

  deleteLibraryPaper(uniqueId: string): boolean {
    const result = this.requireDb().prepare('DELETE FROM library_papers WHERE unique_id = ?').run(uniqueId)
    return result.changes > 0
  }

  countLibraryPapers(): number {
    const row = this.requireDb().prepare('SELECT COUNT(*) AS count FROM library_papers').get()
    return Number((row as { count: SQLOutputValue } | undefined)?.count ?? 0)
  }

  /** All unique ids already in the global library (first-pass tracking dedupe). */
  libraryUniqueIds(): Set<string> {
    const rows = this.requireDb().prepare('SELECT unique_id FROM library_papers').all()
    return new Set((rows as unknown as { unique_id: string }[]).map(row => row.unique_id))
  }

  /** Global library entries, newest first. Optional `query` uses library FTS. */
  listLibraryPapers(limit = 100, query?: string): CuratedPaperView[] {
    if (query !== undefined && query.trim().length > 0) {
      return this.searchLibraryPapers({ query, limit: clampInteger(limit, 1, 500) })
    }
    const rows = this.requireDb().prepare(
      `SELECT * FROM library_papers ORDER BY added_at DESC, unique_id DESC LIMIT ?`,
    ).all(clampInteger(limit, 1, 500))
    return rows as unknown as CuratedPaperView[]
  }

  /**
   * Filtered library search. A non-empty `query` runs an FTS5 match ordered by
   * relevance; when FTS5 returns nothing or the query is CJK, it falls back to
   * a substring scan over title/abstract/journal/authors.
   */
  searchLibraryPapers(filters: PaperFilters = {}): LibraryPaperRecord[] {
    const db = this.requireDb()
    const limit = clampInteger(filters.limit ?? 20, 1, 100)
    const offset = clampInteger(filters.offset ?? 0, 0, 1_000_000)
    const query = filters.query?.trim() ?? ''
    const { where, params } = buildFilterClause(filters)
    const useFts = query.length > 0 && !CJK.test(query)

    if (useFts) {
      const conditions = ['library_fts MATCH ?', ...where]
      const matchParams: SQLInputValue[] = [toFtsQuery(query), ...params]
      const rows = db.prepare(
        `SELECT p.* FROM library_papers p
         JOIN library_fts ON library_fts.rowid = p.rowid
         WHERE ${conditions.join(' AND ')}
         ORDER BY bm25(library_fts)
         LIMIT ? OFFSET ?`,
      ).all(...matchParams, limit, offset)
      const papers = rows as unknown as LibraryPaperRecord[]
      if (papers.length > 0) return papers
    }
    return this.substringSearchLibrary(query, filters, limit, offset)
  }

  private substringSearchLibrary(query: string, filters: PaperFilters, limit: number, offset: number): LibraryPaperRecord[] {
    const db = this.requireDb()
    const { where, params } = buildFilterClause(filters)
    const whereSql = [...where].join(' AND ')
    const like = `%${escapeLike(query)}%`
    const sql = `SELECT * FROM library_papers p
      WHERE (p.title LIKE ? ESCAPE '\\' OR p.abstract LIKE ? ESCAPE '\\' OR p.journal LIKE ? ESCAPE '\\' OR p.authors LIKE ? ESCAPE '\\')
      ${whereSql.length > 0 ? `AND ${whereSql}` : ''}
      ORDER BY p.year DESC, p.added_at DESC
      LIMIT ? OFFSET ?`
    const rows = db.prepare(sql).all(like, like, like, like, ...params, limit, offset)
    return rows as unknown as LibraryPaperRecord[]
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
   * Import a batch of papers into the global library in one transaction.
   * Invalid records (missing or empty unique id/title) are counted as failed
   * without aborting the batch.
   */
  importPapers(records: PaperInput[]): ImportResult {
    const db = this.requireDb()
    const result: ImportResult = { imported: 0, skipped: 0, failed: 0, errors: [] }
    db.exec('BEGIN IMMEDIATE')
    try {
      let index = 0
      for (const record of records) {
        index += 1
        const uniqueId = record.doi?.trim() ?? ''
        const title = record.title?.trim() ?? ''
        if (uniqueId.length === 0 || title.length === 0) {
          result.failed += 1
          result.errors.push(`record ${index}: doi and title are required`)
          continue
        }
        const existed = this.getLibraryPaper(uniqueId) !== null
        const { doi: _doi, ...paperFields } = record
        void _doi
        this.upsertLibraryPaper({
          ...definedEntries(paperFields),
          unique_id: uniqueId,
          title,
          relevance: 'medium',
        })
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

  /** Write the library, cache, and journals to `destination` as one JSON document. */
  exportToJson(destination: string): { path: string; count: number } {
    const db = this.requireDb()
    const target = resolve(destination)
    mkdirSync(dirname(target), { recursive: true })
    const library = db.prepare('SELECT * FROM library_papers ORDER BY year DESC, added_at DESC').all()
    const cache = db.prepare('SELECT * FROM papers ORDER BY year DESC, created_at DESC').all()
    const journals = db.prepare('SELECT * FROM journals ORDER BY journal_title ASC').all()
    const document = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowIso(),
      library,
      cache,
      papers: library,
      journals,
    }
    writeFileSync(target, JSON.stringify(document, null, 2), 'utf8')
    return { path: target, count: (library as unknown[]).length }
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
         (SELECT COUNT(*) FROM papers) AS cache,
         (SELECT COUNT(*) FROM library_papers) AS library,
         (SELECT COUNT(*) FROM journals) AS journals,
         (SELECT MIN(year) FROM library_papers) AS min_year,
         (SELECT MAX(year) FROM library_papers) AS max_year`,
    ).get()
    const values = (row ?? {}) as {
      cache?: SQLOutputValue
      library?: SQLOutputValue
      journals?: SQLOutputValue
      min_year?: SQLOutputValue
      max_year?: SQLOutputValue
    }
    let sizeBytes = 0
    try {
      sizeBytes = statSync(this.path).size
    } catch {
      sizeBytes = 0
    }
    const cacheCount = Number(values.cache ?? 0)
    return {
      dbPath: this.path,
      sizeBytes,
      schemaVersion: SCHEMA_VERSION,
      paperCount: cacheCount,
      cacheCount,
      libraryCount: Number(values.library ?? 0),
      journalCount: Number(values.journals ?? 0),
      earliestYear: values.min_year === null || values.min_year === undefined ? null : Number(values.min_year),
      latestYear: values.max_year === null || values.max_year === undefined ? null : Number(values.max_year),
    }
  }
}

// --------------------------------------------------------------- helpers

function readSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value?: SQLOutputValue } | undefined
    const parsed = Number(row?.value ?? 0)
    return Number.isFinite(parsed) ? parsed : 0
  } catch {
    return 0
  }
}

interface V3CuratedJoinRow {
  unique_id: string
  relevance: CurationRelevance
  note: string | null
  plan_id: string
  added_at: string
  title: string | null
  authors: string | null
  journal: string | null
  issn: string | null
  eissn: string | null
  publication_date: string | null
  year: number | null
  abstract: string | null
  url: string | null
  source: string | null
  is_open_access: number | null
  citation_count: number | null
  impact_factor: number | null
  cas_partition: number | null
  is_sci: number | null
}

/**
 * Copy v3 `curated_papers JOIN papers` into the global library. The same
 * unique_id across directions becomes one row: higher relevance wins, notes
 * are concatenated.
 */
function migrateV3CuratedToLibrary(db: DatabaseSync): void {
  let rows: V3CuratedJoinRow[] = []
  try {
    rows = db.prepare(
      `SELECT
         c.unique_id, c.relevance, c.note, c.plan_id, c.added_at,
         p.title, p.authors, p.journal, p.issn, p.eissn, p.publication_date,
         p.year, p.abstract, p.url, p.source, p.is_open_access, p.citation_count,
         p.impact_factor, p.cas_partition, p.is_sci
       FROM curated_papers c
       LEFT JOIN papers p ON p.doi = c.unique_id`,
    ).all() as unknown as V3CuratedJoinRow[]
  } catch {
    return
  }
  if (rows.length === 0) return

  const merged = new Map<string, V3CuratedJoinRow & { notes: string[] }>()
  for (const row of rows) {
    const current = merged.get(row.unique_id)
    const note = row.note?.trim() ?? ''
    if (current === undefined) {
      merged.set(row.unique_id, { ...row, notes: note.length > 0 ? [note] : [] })
      continue
    }
    if (note.length > 0) current.notes.push(note)
    const currentRank = RELEVANCE_RANK[current.relevance] ?? 0
    const nextRank = RELEVANCE_RANK[row.relevance] ?? 0
    if (nextRank > currentRank) {
      current.relevance = row.relevance
      current.plan_id = row.plan_id
    }
    if (current.title === null && row.title !== null) {
      Object.assign(current, {
        title: row.title,
        authors: row.authors,
        journal: row.journal,
        issn: row.issn,
        eissn: row.eissn,
        publication_date: row.publication_date,
        year: row.year,
        abstract: row.abstract,
        url: row.url,
        source: row.source,
        is_open_access: row.is_open_access,
        citation_count: row.citation_count,
        impact_factor: row.impact_factor,
        cas_partition: row.cas_partition,
        is_sci: row.is_sci,
      })
    }
    if (row.added_at < current.added_at) current.added_at = row.added_at
  }

  const insert = db.prepare(
    `INSERT INTO library_papers (
       unique_id, title, authors, journal, issn, eissn, publication_date, year,
       abstract, url, source, is_open_access, citation_count, impact_factor,
       cas_partition, is_sci, relevance, note, source_plan_id, added_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(unique_id) DO NOTHING`,
  )
  const now = nowIso()
  for (const row of merged.values()) {
    insert.run(
      row.unique_id,
      row.title ?? row.unique_id,
      row.authors ?? '[]',
      row.journal,
      row.issn,
      row.eissn,
      row.publication_date,
      row.year,
      row.abstract,
      row.url,
      row.source ?? DEFAULT_SOURCE,
      row.is_open_access ?? 0,
      row.citation_count ?? 0,
      row.impact_factor,
      row.cas_partition,
      row.is_sci ?? 0,
      row.relevance,
      row.notes.length > 0 ? row.notes.join(' | ') : null,
      row.plan_id,
      row.added_at,
      now,
    )
  }
}

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
