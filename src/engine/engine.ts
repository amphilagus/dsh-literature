/**
 * Literature search engine: merges local SQLite FTS results with Crossref
 * API results, deduplicates by DOI (local records win), optionally caches
 * remote hits into the database, and serves DOI lookups local-first.
 * @module @amphilagus/dsh-literature/engine
 */

import { LiteratureDatabase } from '../db/database.ts'
import type { PaperFilters, PaperRecord } from '../db/types.ts'
import { normalizeDoi, toPaperInput, type CrossrefSearchApi, type CrossrefWork } from './crossref.ts'
import type { GetResult, PaperHit, PaperSource, SearchOptions, SearchResult } from './types.ts'

export { normalizeDoi } from './crossref.ts'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseAuthors(record: PaperRecord): string[] {
  try {
    const parsed: unknown = JSON.parse(record.authors)
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === 'string')
    }
  } catch {
    // fall through
  }
  return []
}

/** Project a stored record into a model-facing hit. */
export function toHit(record: PaperRecord, source: PaperSource): PaperHit {
  return {
    doi: record.doi,
    title: record.title,
    authors: parseAuthors(record),
    journal: record.journal,
    year: record.year,
    publicationDate: record.publication_date,
    abstract: record.abstract,
    url: record.url,
    openAccess: record.is_open_access === 1,
    citations: record.citation_count,
    source,
  }
}

/** Project a fresh Crossref work into a model-facing hit. */
export function toHitFromWork(work: CrossrefWork): PaperHit {
  const input = toPaperInput(work)
  if (input === null) {
    return {
      doi: '',
      title: work.title?.[0] ?? 'Untitled',
      authors: [],
      journal: work['container-title']?.[0] ?? null,
      year: null,
      publicationDate: null,
      abstract: null,
      url: null,
      openAccess: false,
      citations: 0,
      source: 'crossref',
    }
  }
  return toHit(input as PaperRecord, 'crossref')
}

export interface LiteratureEngineOptions {
  /** Store remote hits into the local database. Defaults to true. */
  cacheRemote?: boolean
}

export class LiteratureSearchEngine {
  constructor(
    /** The local literature database. */
    readonly db: LiteratureDatabase,
    /** The Crossref backend. */
    readonly crossref: CrossrefSearchApi,
    private readonly options: LiteratureEngineOptions = {},
  ) {}

  /** Search local and/or Crossref sources and merge by DOI. */
  async search(query: string, options: SearchOptions = {}, signal?: AbortSignal): Promise<SearchResult> {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      return { ok: false, code: 'invalid_query', message: 'query must be a non-empty string' }
    }
    const limit = clamp(options.limit ?? 20, 1, 50)
    const sources = options.sources ?? 'both'
    const warnings: string[] = []
    const merged = new Map<string, PaperHit>()
    const usedSources: PaperSource[] = []
    let truncated = false

    const localFilters: PaperFilters = {
      query: trimmed,
      limit,
      ...options.journal !== undefined && options.journal.trim().length > 0 ? { journal: options.journal } : {},
      ...options.fromYear !== undefined ? { fromYear: options.fromYear } : {},
      ...options.toYear !== undefined ? { toYear: options.toYear } : {},
      ...options.openAccess !== undefined ? { openAccess: options.openAccess } : {},
      ...options.minCitations !== undefined ? { minCitations: options.minCitations } : {},
    }

    if (sources === 'local' || sources === 'both') {
      usedSources.push('local')
      try {
        for (const record of this.db.searchPapers(localFilters)) {
          if (!merged.has(record.doi)) merged.set(record.doi, toHit(record, 'local'))
        }
      } catch (error) {
        warnings.push(`local search failed: ${messageOf(error)}`)
      }
    }

    if (sources === 'crossref' || sources === 'both') {
      usedSources.push('crossref')
      const filterParts: string[] = []
      if (options.fromYear !== undefined) filterParts.push(`from-pub-date:${options.fromYear}-01-01`)
      if (options.toYear !== undefined) filterParts.push(`until-pub-date:${options.toYear}-12-31`)
      if (options.journal !== undefined && options.journal.trim().length > 0) {
        filterParts.push(`container-title:${options.journal.trim()}`)
      }
      filterParts.push('type:journal-article')
      try {
        const page = await this.crossref.searchWorks({
          query: trimmed,
          rows: limit,
          filter: filterParts.join(','),
          sort: options.sortBy === 'date' ? 'published' : 'relevance',
          ...options.sortBy === 'date' ? { order: 'desc' as const } : {},
        }, signal)
        truncated = page.total > page.works.length
        for (const work of page.works) {
          const input = toPaperInput(work)
          if (input === null) continue
          if (this.options.cacheRemote !== false) {
            try {
              this.db.upsertPaper(input)
            } catch {
              // caching is best-effort; the search result still carries the hit
            }
          }
          if (!merged.has(input.doi)) merged.set(input.doi, toHitFromWork(work))
        }
      } catch (error) {
        if (signal?.aborted) throw error
        warnings.push(`crossref search failed: ${messageOf(error)}`)
      }
    }

    let papers = [...merged.values()]
    if (options.sortBy === 'date') {
      papers = papers.sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    }
    return {
      ok: true,
      query: trimmed,
      sources: usedSources,
      total: papers.length,
      truncated,
      warnings,
      papers: papers.slice(0, limit),
    }
  }

  /** DOI lookup: local cache first, then Crossref (and cache the fetch). */
  async get(doi: string, forceRemote = false, signal?: AbortSignal): Promise<GetResult> {
    const normalized = normalizeDoi(doi)
    if (normalized === null) {
      return { ok: false, code: 'invalid_doi', message: `"${doi}" is not a valid DOI` }
    }
    if (!forceRemote) {
      try {
        const cached = this.db.getPaper(normalized)
        if (cached !== null) return { ok: true, cached: true, paper: toHit(cached, 'local') }
      } catch (error) {
        // a broken cache must not block the remote lookup
        void error
      }
    }
    try {
      const work = await this.crossref.getWork(normalized, signal)
      if (work === null) {
        return { ok: false, code: 'not_found', message: `Crossref has no work with DOI ${normalized}` }
      }
      const input = toPaperInput(work)
      if (input === null) {
        return { ok: false, code: 'not_found', message: `Crossref work ${normalized} carries no DOI record` }
      }
      try {
        this.db.upsertPaper(input)
      } catch {
        // caching is best-effort
      }
      return { ok: true, cached: false, paper: toHitFromWork(work) }
    } catch (error) {
      if (signal?.aborted) throw error
      return { ok: false, code: 'crossref_error', message: `Crossref lookup failed: ${messageOf(error)}` }
    }
  }
}
