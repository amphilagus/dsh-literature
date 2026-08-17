/**
 * Bundled SCI journal catalog: titles, print/eISSN, impact factor, CAS
 * partition and discipline. Used to pick a tracking-plan journal whitelist.
 * @module @amphilagus/dsh-literature/db/catalog
 */

import { copyFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { SQLOutputValue } from 'node:sqlite'
import { escapeLike } from './database.ts'

/** One row from the bundled `sci_journals` catalog. */
export interface SciJournalHit {
  title: string
  issn: string | null
  eissn: string | null
  publisher: string | null
  impactFactor: number | null
  casPartition: number | null
  casDiscipline: string | null
  webOfScienceCategories: string | null
}

/** Filters for {@link SciJournalCatalog.search}. */
export interface SciJournalSearchOptions {
  /** Substring over title, ISSN, eISSN, CAS discipline, and WoS categories. */
  query?: string
  /** Restrict to a CAS discipline substring (e.g. "物理", "化学"). */
  discipline?: string
  limit?: number
}

const CATALOG_FILENAME = 'sci_journals.db'

/** Packaged catalog next to this source file or beside `lib/`. */
export function bundledSciJournalsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const fromSrc = join(here, '..', '..', 'data', CATALOG_FILENAME)
  const fromLib = join(here, '..', 'data', CATALOG_FILENAME)
  if (existsSync(fromSrc)) return fromSrc
  if (existsSync(fromLib)) return fromLib
  return fromSrc
}

/** Copy the bundled catalog into the literature data directory when missing or stale. */
export function installSciJournalsCatalog(dataDir: string, sourcePath = bundledSciJournalsPath()): string {
  const dest = join(dataDir, CATALOG_FILENAME)
  if (!existsSync(sourcePath)) return dest
  const stale = !existsSync(dest) || statSync(dest).size !== statSync(sourcePath).size
  if (stale) copyFileSync(sourcePath, dest)
  return dest
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return 20
  return Math.min(50, Math.max(1, Math.trunc(value)))
}

function asText(value: SQLOutputValue | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function asNumber(value: SQLOutputValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toHit(row: Record<string, SQLOutputValue>): SciJournalHit {
  return {
    title: asText(row.journal_title) ?? '',
    issn: asText(row.issn),
    eissn: asText(row.eissn),
    publisher: asText(row.publisher_name),
    impactFactor: asNumber(row.impact_factor),
    casPartition: asNumber(row.cas_partition),
    casDiscipline: asText(row.cas_discipline),
    webOfScienceCategories: asText(row.web_of_science_categories),
  }
}

/** Read-only SCI journal catalog (print ISSN / eISSN, not ISBN). */
export class SciJournalCatalog {
  readonly path: string
  private db: DatabaseSync | undefined

  constructor(path: string) {
    this.path = path
  }

  open(): void {
    if (this.db !== undefined) return
    if (!existsSync(this.path)) return
    this.db = new DatabaseSync(this.path, { readOnly: true })
  }

  close(): void {
    this.db?.close()
    this.db = undefined
  }

  get isOpen(): boolean {
    return this.db !== undefined
  }

  count(): number {
    if (this.db === undefined) return 0
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM sci_journals').get()
    return Number((row as { count: SQLOutputValue } | undefined)?.count ?? 0)
  }

  /**
   * Ranked catalog search: CAS partition first (1 is best), then impact factor.
   * `query` matches journal title, print ISSN, eISSN, discipline, and WoS categories.
   */
  search(options: SciJournalSearchOptions = {}): SciJournalHit[] {
    if (this.db === undefined) return []
    const limit = clampLimit(options.limit)
    const where: string[] = []
    const params: string[] = []
    const query = options.query?.trim() ?? ''
    if (query.length > 0) {
      const like = `%${escapeLike(query)}%`
      where.push(`(
        journal_title LIKE ? ESCAPE '\\'
        OR IFNULL(issn, '') LIKE ? ESCAPE '\\'
        OR IFNULL(eissn, '') LIKE ? ESCAPE '\\'
        OR IFNULL(cas_discipline, '') LIKE ? ESCAPE '\\'
        OR IFNULL(web_of_science_categories, '') LIKE ? ESCAPE '\\'
      )`)
      params.push(like, like, like, like, like)
    }
    const discipline = options.discipline?.trim() ?? ''
    if (discipline.length > 0) {
      where.push(`IFNULL(cas_discipline, '') LIKE ? ESCAPE '\\'`)
      params.push(`%${escapeLike(discipline)}%`)
    }
    const sql = `SELECT journal_title, issn, eissn, publisher_name, impact_factor,
                        cas_partition, cas_discipline, web_of_science_categories
                 FROM sci_journals
                 ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY CASE WHEN cas_partition IS NULL THEN 99 ELSE cas_partition END ASC,
                          impact_factor DESC,
                          journal_title ASC
                 LIMIT ?`
    const rows = this.db.prepare(sql).all(...params, limit)
    return (rows as Record<string, SQLOutputValue>[]).map(toHit)
  }
}
