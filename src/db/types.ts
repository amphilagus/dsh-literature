/**
 * Record types and filter shapes for the literature database.
 * @module @amphilagus/dsh-literature/db/types
 */

/** One paper row as stored in the `papers` table. */
export interface PaperRecord {
  /** DOI, the primary key. */
  doi: string
  title: string
  /** JSON-encoded array of author-name strings. */
  authors: string
  journal: string | null
  issn: string | null
  eissn: string | null
  /** ISO date (`YYYY-MM-DD`) or full ISO timestamp. */
  publication_date: string | null
  year: number | null
  abstract: string | null
  url: string | null
  source: string
  /** 0/1. */
  is_open_access: number
  citation_count: number
  impact_factor: number | null
  cas_partition: number | null
  /** 0/1. */
  is_sci: number
  created_at: string
  updated_at: string
}

/** Fields a caller supplies for an upsert/import; everything else is defaulted. */
export type PaperInput = Partial<PaperRecord> & Pick<PaperRecord, 'doi' | 'title'>

/** One journal row as stored in the `journals` table. */
export interface JournalRecord {
  /** Journal id, usually the ISSN. */
  id: string
  journal_title: string
  abbreviated_title: string | null
  issn: string | null
  eissn: string | null
  impact_factor: number | null
  impact_factor_5year: number | null
  cas_partition: number | null
  cas_discipline: string | null
  /** 0/1. */
  is_sci: number
  web_of_science_categories: string | null
  created_at: string
  updated_at: string
}

/** Fields a caller supplies for a journal upsert. */
export type JournalInput = Partial<JournalRecord> & Pick<JournalRecord, 'id' | 'journal_title'>

/** Filters for a paper search over the local database. */
export interface PaperFilters {
  /** Free-text query matched against title/abstract/journal/authors. */
  query?: string
  /** Journal-name substring match. */
  journal?: string
  /** Data source (`crossref`, `manual`, ...). */
  source?: string
  fromYear?: number
  toYear?: number
  openAccess?: boolean
  minCitations?: number
  casPartition?: number
  limit?: number
  offset?: number
}

/** Aggregate statistics over the database. */
export interface DatabaseStats {
  dbPath: string
  sizeBytes: number
  schemaVersion: number
  paperCount: number
  journalCount: number
  earliestYear: number | null
  latestYear: number | null
}

/** Per-record outcome of an import batch. */
export interface ImportResult {
  imported: number
  skipped: number
  failed: number
  errors: string[]
}

// ------------------------------------------------------- literature tracking

/** Tracked-direction kind: a research topic or a specific researcher. */
export type TrackingPlanKind = 'topic' | 'person'

/** Curation relevance grades assigned by the screening agent. */
export type CurationRelevance = 'very_high' | 'high' | 'medium' | 'low'

/** One row of the tracking-plans table (文献跟踪方案表). */
export interface TrackingPlanRecord {
  id: string
  /** Direction name: the topic phrase or the researcher name. */
  name: string
  kind: TrackingPlanKind
  /** JSON-encoded ISSN array; the journal whitelist for `topic` plans. */
  journal_whitelist: string | null
  /** ORCID, required for `person` plans. */
  orcid: string | null
  /** Search window in days (近3天/近一周/近一月...). */
  time_window_days: number
  /** Scheduling period in days for the reminder (agent self-renewal). */
  search_interval_days: number
  /** 0/1. */
  enabled: number
  notes: string | null
  created_at: string
  updated_at: string
}

/** Fields a caller supplies for a tracking-plan upsert. */
export type TrackingPlanInput = Partial<Omit<TrackingPlanRecord, 'created_at' | 'updated_at'>>
  & Pick<TrackingPlanRecord, 'name' | 'kind'>

/** One curated entry of the new direction library (新库). */
export interface CuratedPaperRecord {
  id: number
  plan_id: string
  /** Canonical DOI or `arxiv:xxxx.xxxxx` id (the cross-source unique key). */
  unique_id: string
  relevance: CurationRelevance
  note: string | null
  added_at: string
}

/** Curated entry joined with its source paper (title/journal/url). */
export interface CuratedPaperView extends CuratedPaperRecord {
  title: string | null
  journal: string | null
  url: string | null
  publication_date: string | null
}

/** One finding reported by the agent when closing a search log. */
export interface SearchFinding {
  /** Canonical unique id (DOI or arxiv:...). */
  unique_id: string
  title?: string
  url?: string
  /** One-sentence digest written by the screening agent. */
  summary: string
}

/** One row of the search-log table (搜索记录表). */
export interface SearchLogRecord {
  id: number
  plan_id: string
  started_at: string
  window_start: string
  window_end: string
  status: 'running' | 'done'
  /** JSON-encoded {@link SearchFinding} array. */
  findings: string | null
  summary: string | null
  completed_at: string | null
}

/** Fields a caller supplies when closing a search log. */
export interface SearchLogCompletion {
  findings: SearchFinding[]
  summary?: string
}

// ------------------------------------------------------- researcher profiles

/** Archived profiles stay in the database but are hidden from the default list. */
export type ResearcherProfileStatus = 'active' | 'archived'

/** One row of the researcher-profiles table. JSON columns are stored as TEXT. */
export interface ResearcherProfileRecord {
  id: string
  display_name: string
  family_name: string | null
  given_name: string | null
  name_zh: string | null
  orcid: string
  institution: string | null
  homepage: string | null
  email: string | null
  /** JSON-encoded `{area, confidence, evidence}[]`. */
  research_areas: string | null
  /** JSON-encoded string array of name variants. */
  aliases: string | null
  disambiguation_notes: string | null
  plan_id: string | null
  notes: string | null
  status: ResearcherProfileStatus
  created_at: string
  updated_at: string
}

/** Fields a caller supplies for a researcher-profile upsert. */
export type ResearcherProfileInput = Partial<Omit<ResearcherProfileRecord, 'created_at' | 'updated_at'>>
  & Pick<ResearcherProfileRecord, 'id' | 'display_name' | 'orcid'>
