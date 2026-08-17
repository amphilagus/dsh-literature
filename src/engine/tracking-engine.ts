/**
 * Tracking search engine: runs one direction's configured search over
 * Crossref AND arXiv, applies the topic journal whitelist, caches every hit
 * into the legacy paper database, and performs the first-pass dedupe against
 * the direction's curated library. The screening agent then reads the
 * candidates and curates the matching ones through `tracking_curate`.
 * @module @amphilagus/dsh-literature/engine/tracking
 */

import { LiteratureDatabase } from '../db/database.ts'
import type { TrackingPlanRecord } from '../db/types.ts'
import {
  arxivAuthorQuery,
  arxivUniqueId,
  toArxivPaperInput,
} from './arxiv.ts'
import type { ArxivSearchApi } from './arxiv.ts'
import { normalizeDoi, toPaperInput } from './crossref.ts'
import type { CrossrefSearchApi } from './crossref.ts'

/** One candidate hit returned to the screening agent. */
export interface TrackingCandidate {
  /** Canonical unique id: DOI or `arxiv:xxxx.xxxxx`. */
  unique_id: string
  title: string
  url: string
  /** Publication/submission date (`YYYY-MM-DD`). */
  date: string | null
  source: 'crossref' | 'arxiv'
  journal: string | null
  authors: string[]
}

/** A hit dropped by the first-pass dedupe (already curated for this plan). */
export interface DedupedHit {
  unique_id: string
  title: string
}

export interface TrackingSearchOutcome {
  plan_id: string
  plan_name: string
  window_start: string
  window_end: string
  /** Search-log id for this run; complete it with `tracking_log_complete`. */
  log_id: number
  candidates: TrackingCandidate[]
  /** Hits auto-filtered because this direction already curates them. */
  excluded_already_curated: DedupedHit[]
  warnings: string[]
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function parseWhitelist(raw: string | null): Set<string> | null {
  if (raw === null || raw.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const set = new Set<string>()
    for (const value of parsed) {
      if (typeof value === 'string' && value.trim().length > 0) {
        set.add(value.trim().toLowerCase())
      }
    }
    return set.size > 0 ? set : null
  } catch {
    return null
  }
}

export interface TrackingEngineOptions {
  cacheRemote?: boolean
}

export class TrackingSearchEngine {
  constructor(
    private readonly db: LiteratureDatabase,
    private readonly crossref: CrossrefSearchApi,
    private readonly arxiv: ArxivSearchApi,
    private readonly options: TrackingEngineOptions = {},
  ) {}

  /** Run one direction's search. Throws on remote failures after retries. */
  async searchPlan(plan: TrackingPlanRecord, signal?: AbortSignal): Promise<TrackingSearchOutcome> {
    const warnings: string[] = []
    const windowStart = isoDaysAgo(Math.max(1, plan.time_window_days) - 1)
    const windowEnd = isoToday()
    const logId = this.db.startSearchLog(plan.id, windowStart, windowEnd)

    const byId = new Map<string, TrackingCandidate>()
    const push = (candidate: TrackingCandidate): void => {
      const existing = byId.get(candidate.unique_id)
      if (existing === undefined || candidate.date !== null && (existing.date === null || candidate.date > existing.date)) {
        byId.set(candidate.unique_id, candidate)
      }
    }

    // --- Crossref leg
    const filter = `from-pub-date:${windowStart},until-pub-date:${windowEnd}`
    if (plan.kind === 'person') {
      const orcidFilter = plan.orcid !== null && plan.orcid.trim().length > 0
        ? `,orcid:${plan.orcid.trim()}`
        : ''
      try {
        const page = await this.crossref.searchWorks({
          query: plan.name,
          rows: 100,
          filter: `${filter}${orcidFilter}`,
          sort: 'published',
          order: 'desc',
        }, signal)
        for (const work of page.works) {
          const input = toPaperInput(work)
          if (input === null) continue
          if (this.options.cacheRemote !== false) this.db.upsertPaper(input)
          push({
            unique_id: input.doi.toLowerCase(),
            title: input.title,
            url: input.url ?? `https://doi.org/${input.doi}`,
            date: input.publication_date ?? null,
            source: 'crossref',
            journal: input.journal ?? null,
            authors: safeAuthors(input.authors ?? null),
          })
        }
      } catch (error) {
        warnings.push(`crossref person search failed: ${messageOf(error)}`)
      }
    } else {
      const whitelist = parseWhitelist(plan.journal_whitelist)
      try {
        const page = await this.crossref.searchWorks({
          query: plan.name,
          rows: 100,
          filter,
          sort: 'published',
          order: 'desc',
        }, signal)
        for (const work of page.works) {
          if (whitelist !== null) {
            const issns = (work.ISSN ?? []).map(issn => issn.toLowerCase())
            if (!issns.some(issn => whitelist.has(issn))) continue
          }
          const input = toPaperInput(work)
          if (input === null) continue
          if (this.options.cacheRemote !== false) this.db.upsertPaper(input)
          push({
            unique_id: input.doi.toLowerCase(),
            title: input.title,
            url: input.url ?? `https://doi.org/${input.doi}`,
            date: input.publication_date ?? null,
            source: 'crossref',
            journal: input.journal ?? null,
            authors: safeAuthors(input.authors ?? null),
          })
        }
      } catch (error) {
        warnings.push(`crossref topic search failed: ${messageOf(error)}`)
      }
    }

    // --- arXiv leg (phrase query for topics, author query for persons)
    const arxivQuery = plan.kind === 'person' ? arxivAuthorQuery(plan.name) : `all:"${plan.name.replaceAll('"', '""')}"`
    if (arxivQuery.length > 0) {
      try {
        const entries = await this.arxiv.search({
          query: arxivQuery,
          startDate: windowStart,
          endDate: windowEnd,
          maxResults: 50,
          sortBy: 'submittedDate',
          sortOrder: 'descending',
        }, signal)
        for (const entry of entries) {
          const input = toArxivPaperInput(entry)
          if (this.options.cacheRemote !== false) this.db.upsertPaper(input)
          push({
            unique_id: arxivUniqueId(entry),
            title: entry.title,
            url: entry.url,
            date: entry.published.slice(0, 10),
            source: 'arxiv',
            journal: entry.journalRef ?? 'arXiv',
            authors: entry.authors,
          })
        }
      } catch (error) {
        warnings.push(`arxiv search failed: ${messageOf(error)}`)
      }
    } else if (plan.kind === 'person') {
      warnings.push('arxiv author query empty for this plan name')
    }

    // --- first-pass dedupe against THIS direction's curated library
    const curated = this.db.curatedUniqueIds(plan.id)
    const excluded: DedupedHit[] = []
    const candidates: TrackingCandidate[] = []
    for (const candidate of byId.values()) {
      if (curated.has(candidate.unique_id)) {
        excluded.push({ unique_id: candidate.unique_id, title: candidate.title })
      } else {
        candidates.push(candidate)
      }
    }
    candidates.sort((left, right) => (right.date ?? '').localeCompare(left.date ?? ''))

    return {
      plan_id: plan.id,
      plan_name: plan.name,
      window_start: windowStart,
      window_end: windowEnd,
      log_id: logId,
      candidates,
      excluded_already_curated: excluded,
      warnings,
    }
  }
}

/** Normalize one candidate id (DOI prefix stripping or arxiv: pass-through). */
export function normalizeCandidateId(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const arxiv = trimmed.match(/^(?:https?:\/\/arxiv\.org\/abs\/)?([0-9]{4}\.[0-9]{4,5})(?:v[0-9]+)?$/i)
  if (arxiv !== null && arxiv[1] !== undefined) return `arxiv:${arxiv[1]}`
  return normalizeDoi(trimmed)
}

function safeAuthors(encoded: string | null): string[] {
  if (encoded === null || encoded.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(encoded)
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : []
  } catch {
    return []
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
