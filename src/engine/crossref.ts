/**
 * Crossref REST API client: work search, DOI lookup, and recent-paper
 * queries with polite-pool identification, timeouts, and bounded retries.
 * The Crossref response mapping (JATS abstract stripping, author arrays,
 * ISSN types) is ported from the keyanqu literature_processor backend.
 * @module @amphilagus/dsh-literature/engine/crossref
 */

import type { PaperInput } from '../db/types.ts'

/** Default Crossref works endpoint. */
export const DEFAULT_CROSSREF_BASE_URL = 'https://api.crossref.org/works'

export interface CrossrefClientOptions {
  /** Works API base URL, e.g. `https://api.crossref.org/works`. */
  baseUrl?: string
  /** Polite-pool contact email, sent as the `mailto` query parameter. */
  mailto?: string
  /** Per-request timeout in ms; default 20000. */
  timeoutMs?: number
  /** Total attempts per request; default 3. */
  maxRetries?: number
}

export interface SearchWorksParams {
  query: string
  rows?: number
  offset?: number
  /** Crossref `filter` fragment, e.g. `from-pub-date:2019-01-01,type:journal-article`. */
  filter?: string
  sort?: 'relevance' | 'published'
  order?: 'asc' | 'desc'
}

/** The subset of a Crossref work record the engine consumes. */
export interface CrossrefWork {
  DOI?: string
  title?: string[]
  author?: { given?: string; family?: string; name?: string }[]
  'container-title'?: string[]
  ISSN?: string[]
  'issn-type'?: { type?: string; value?: string }[]
  published?: { 'date-parts'?: number[][] }
  abstract?: string
  URL?: string
  license?: { URL?: string }[]
  'is-referenced-by-count'?: number
}

/** One page of Crossref search results. */
export interface CrossrefSearchPage {
  works: CrossrefWork[]
  total: number
}

/** The engine's view of a Crossref client (implemented by CrossrefClient). */
export interface CrossrefSearchApi {
  searchWorks(params: SearchWorksParams, signal?: AbortSignal): Promise<CrossrefSearchPage>
  getWork(doi: string, signal?: AbortSignal): Promise<CrossrefWork | null>
}

export class CrossrefError extends Error {
  readonly status: number | undefined

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'CrossrefError'
    this.status = options.status
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Strip JATS/HTML tags and unescape entities from a Crossref abstract. */
export function stripJats(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Normalize a user-supplied DOI: strip URL/doi prefixes, lowercase, validate. */
export function normalizeDoi(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const withoutPrefix = trimmed
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim()
  const doi = withoutPrefix.toLowerCase()
  if (!/^10\.\d{4,9}\/\S+$/u.test(doi)) return null
  return doi
}

/** Map one Crossref work into a database paper input; null without a DOI. */
export function toPaperInput(work: CrossrefWork): PaperInput | null {
  const doi = work.DOI ?? ''
  if (doi.trim().length === 0) return null
  const title = stripJats(work.title?.[0] ?? doi)
  const authors = (work.author ?? [])
    .map(author => {
      const personal = [author.given, author.family].filter(Boolean).join(' ')
      return personal.length > 0 ? personal : (author.name ?? '')
    })
    .filter(name => name.length > 0)
  const dateParts = work.published?.['date-parts']?.[0]
  const year = typeof dateParts?.[0] === 'number' ? dateParts[0] : null
  const publicationDate = dateParts !== undefined && dateParts.length > 0
    ? dateParts.slice(0, 3).map((part, i) => String(part ?? 1).padStart(i === 0 ? 4 : 2, '0')).join('-')
    : null
  const electronicIssn = work['issn-type']?.find(entry => entry.type === 'electronic')?.value
  const isOpenAccess = (work.license ?? []).some(license =>
    /creativecommons|open[ -]?access/i.test(license.URL ?? ''))

  return {
    doi,
    title,
    authors: JSON.stringify(authors),
    journal: work['container-title']?.[0] ?? null,
    issn: work.ISSN?.[0] ?? null,
    eissn: electronicIssn ?? null,
    publication_date: publicationDate,
    year,
    abstract: work.abstract !== undefined ? stripJats(work.abstract) : null,
    url: work.URL ?? `https://doi.org/${doi}`,
    source: 'crossref',
    is_open_access: isOpenAccess ? 1 : 0,
    citation_count: work['is-referenced-by-count'] ?? 0,
  }
}

export class CrossrefClient {
  readonly baseUrl: string
  private readonly mailto: string | undefined
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private lastRequestAt = 0

  constructor(options: CrossrefClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_CROSSREF_BASE_URL).replace(/\/+$/u, '')
    this.mailto = options.mailto
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.maxRetries = Math.max(1, options.maxRetries ?? 3)
  }

  /** Keyword search over Crossref works. */
  async searchWorks(params: SearchWorksParams, signal?: AbortSignal): Promise<CrossrefSearchPage> {
    const query = new URLSearchParams()
    query.set('query', params.query)
    query.set('rows', String(Math.min(params.rows ?? 20, 100)))
    if (params.offset !== undefined) query.set('offset', String(params.offset))
    if (params.filter !== undefined && params.filter.length > 0) query.set('filter', params.filter)
    if (params.sort !== undefined) query.set('sort', params.sort)
    if (params.order !== undefined) query.set('order', params.order)
    // Only the fields the engine maps; notably drops the huge `reference`
    // arrays Crossref returns by default, keeping search responses fast.
    query.set(
      'select',
      'DOI,title,author,container-title,ISSN,issn-type,published,abstract,URL,license,is-referenced-by-count',
    )
    const payload = await this.request('', query, signal)
    const message = (payload?.message ?? {}) as { items?: CrossrefWork[]; 'total-results'?: number }
    return { works: message.items ?? [], total: message['total-results'] ?? 0 }
  }

  /** Look up one work by DOI; null when Crossref answers 404. */
  async getWork(doi: string, signal?: AbortSignal): Promise<CrossrefWork | null> {
    const payload = await this.request(`/${encodeURIComponent(doi)}`, undefined, signal, true)
    return (payload?.message ?? null) as CrossrefWork | null
  }

  /** Works published in the last `days` days, newest first. */
  async fetchRecent(days: number, rows = 20, signal?: AbortSignal): Promise<CrossrefSearchPage> {
    const until = new Date()
    const from = new Date(until.getTime() - days * 86_400_000)
    const iso = (date: Date): string => date.toISOString().slice(0, 10)
    return this.searchWorks({
      query: '',
      rows,
      filter: `from-pub-date:${iso(from)},until-pub-date:${iso(until)}`,
      sort: 'published',
      order: 'desc',
    }, signal)
  }

  /** One GET with polite-pool identification, timeout, and bounded retries. */
  private async request(
    path: string,
    params: URLSearchParams | undefined,
    signal: AbortSignal | undefined,
    allow404 = false,
  ): Promise<Record<string, unknown> | null> {
    const query = params ?? new URLSearchParams()
    if (this.mailto !== undefined && this.mailto.trim().length > 0) {
      query.set('mailto', this.mailto.trim())
    }
    const url = `${this.baseUrl}${path}?${query.toString()}`

    let lastError: unknown
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      // Polite-pool courtesy spacing between requests.
      const elapsed = Date.now() - this.lastRequestAt
      if (elapsed < 200) await sleep(200 - elapsed, signal)
      this.lastRequestAt = Date.now()

      const timeout = AbortSignal.timeout(this.timeoutMs)
      const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      let response: Response
      try {
        response = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': `dsh-literature/0.1 (mailto:${this.mailto ?? 'unset'})`,
          },
          signal: combined,
        })
      } catch (error) {
        lastError = error
        if (combined.aborted && signal?.aborted) throw new CrossrefError('request aborted', { cause: error })
        if (attempt + 1 < this.maxRetries) {
          await sleep(backoffMs(attempt), signal)
          continue
        }
        throw new CrossrefError(`Crossref request failed: ${messageOf(error)}`, { cause: error })
      }

      if (response.ok) return await response.json()

      if (response.status === 404 && allow404) return null
      if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
        throw new CrossrefError(`Crossref answered HTTP ${response.status}`, { status: response.status })
      }
      lastError = new CrossrefError(`Crossref answered HTTP ${response.status}`, { status: response.status })
      if (attempt + 1 < this.maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'))
        await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter, 10) * 1000 : backoffMs(attempt), signal)
      }
    }
    throw new CrossrefError(`Crossref request failed after ${this.maxRetries} attempts: ${messageOf(lastError)}`, { cause: lastError })
  }
}

function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt, 30) * 1000
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CrossrefError('request aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new CrossrefError('request aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
