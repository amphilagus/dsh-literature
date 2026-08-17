/**
 * Search-engine outcome types shared by the engine, tools, and tests.
 * @module @amphilagus/dsh-literature/engine/types
 */

/** Where a hit came from: the local database or the Crossref API. */
export type PaperSource = 'local' | 'crossref'

/** One model-facing paper hit (camelCase projection of a stored record). */
export interface PaperHit {
  doi: string
  title: string
  authors: string[]
  journal: string | null
  year: number | null
  /** ISO date (`YYYY-MM-DD`) or full ISO timestamp. */
  publicationDate: string | null
  abstract: string | null
  url: string | null
  openAccess: boolean
  citations: number
  source: PaperSource
}

export interface SearchOptions {
  /** Maximum papers returned; default 20, capped at 50. */
  limit?: number
  /** Which backends to consult; default `both`. */
  sources?: 'local' | 'crossref' | 'both'
  fromYear?: number
  toYear?: number
  /** Journal-name filter (substring). */
  journal?: string
  openAccess?: boolean
  minCitations?: number
  /** Restrict Crossref results to this researcher (hyphenated ORCID). */
  orcid?: string
  /** Keep only papers whose publicationDate falls in the last N days. */
  recentDays?: number
  /** Internal/local-only sort. Crossref sort is inferred from `orcid`, not this field. */
  sortBy?: 'relevance' | 'date'
  /** Store remote hits into the local database; defaults to the service config. */
  cacheRemote?: boolean
}

/** Successful search outcome. `warnings` is always present, usually empty. */
export interface SearchOutcome {
  ok: true
  query: string
  sources: PaperSource[]
  total: number
  truncated: boolean
  warnings: string[]
  papers: PaperHit[]
}

/** Failed search outcome. */
export interface SearchFailure {
  ok: false
  code: 'invalid_query' | 'invalid_orcid' | 'internal_error'
  message: string
}

export type SearchResult = SearchOutcome | SearchFailure

/** Engine error codes for the DOI lookup path. */
export type GetErrorCode = 'invalid_doi' | 'not_found' | 'crossref_error' | 'internal_error'

/** Successful DOI lookup. */
export interface GetSuccess {
  ok: true
  cached: boolean
  paper: PaperHit
}

/** Failed DOI lookup. */
export interface GetFailure {
  ok: false
  code: GetErrorCode
  message: string
}

export type GetResult = GetSuccess | GetFailure
