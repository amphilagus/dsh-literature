/**
 * Minimal arXiv API client: Atom-feed search over export.arxiv.org with
 * submitted-date windows and author-scoped queries. Parses the Atom XML with
 * regex (no new dependencies) into paper inputs the tracking engine maps into
 * the local database.
 * @module @amphilagus/dsh-literature/engine/arxiv
 */

import type { PaperInput } from '../db/types.ts'

/** Default arXiv export API endpoint. */
export const DEFAULT_ARXIV_BASE_URL = 'https://export.arxiv.org/api/query'

export interface ArxivClientOptions {
  baseUrl?: string
  /** Per-request timeout in ms; default 20000. */
  timeoutMs?: number
}

/** One parsed arXiv entry. */
export interface ArxivEntry {
  /** arXiv id, e.g. `2607.01016`. */
  id: string
  title: string
  summary: string
  /** RFC 3339 submitted/published date. */
  published: string
  authors: string[]
  /** Journal reference when present, e.g. `Phys. Rev. B 113, ...`. */
  journalRef: string | null
  doi: string | null
  /** Primary entry link, e.g. `https://arxiv.org/abs/2607.01016`. */
  url: string
}

export interface ArxivSearchParams {
  /** arXiv search query, e.g. `all:"swift heavy ion"` or `au:"Sand_A"`. */
  query: string
  /** Only entries with submitted/published date on or after this date (YYYY-MM-DD). */
  startDate?: string
  /** Only entries with submitted/published date on or before this date (YYYY-MM-DD). */
  endDate?: string
  maxResults?: number
  sortBy?: 'relevance' | 'submittedDate' | 'lastUpdatedDate'
  sortOrder?: 'ascending' | 'descending'
}

/** The engine's view of an arXiv client. */
export interface ArxivSearchApi {
  search(params: ArxivSearchParams, signal?: AbortSignal): Promise<ArxivEntry[]>
}

export class ArxivError extends Error {
  readonly status: number | undefined

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'ArxivError'
    this.status = options.status
  }
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractFirst(tag: string, entry: string): string | null {
  const match = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  return match === null || match[1] === undefined ? null : decodeEntities(match[1])
}

function extractAll(tag: string, entry: string): string[] {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g')
  const values: string[] = []
  for (const match of entry.matchAll(pattern)) {
    if (match[1] !== undefined) values.push(decodeEntities(match[1]))
  }
  return values
}

/** Parse one Atom `<entry>` block into an {@link ArxivEntry}. */
export function parseArxivEntry(entry: string): ArxivEntry | null {
  const idUrl = extractFirst('id', entry)
  const idMatch = idUrl?.match(/(?:abs\/)?([0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?)$/)
  if (idMatch === undefined || idMatch === null || idMatch[1] === undefined) return null
  const versionless = idMatch[1].replace(/v[0-9]+$/, '')
  const title = extractFirst('title', entry) ?? versionless
  const summary = extractFirst('summary', entry) ?? ''
  const published = extractFirst('published', entry) ?? ''
  const authors = extractAll('name', entry).map(name => name.replace(/\s+/g, ' ').trim()).filter(name => name.length > 0)
  const journalRef = extractFirst('arxiv:journal_ref', entry)
  const doi = extractFirst('arxiv:doi', entry)
  const url = `https://arxiv.org/abs/${versionless}`
  return {
    id: versionless,
    title,
    summary,
    published,
    authors,
    journalRef,
    doi,
    url,
  }
}

/** Map one arXiv entry into a database paper input keyed by DOI or `arxiv:` id. */
export function toArxivPaperInput(entry: ArxivEntry): PaperInput {
  // Prefer the entry DOI as the papers-table key; otherwise store the
  // `arxiv:`-prefixed id so the papers key equals the tracking unique id.
  const key = entry.doi?.trim().length ? entry.doi.trim().toLowerCase() : `arxiv:${entry.id}`
  const year = /^[0-9]{4}/.test(entry.published) ? Number(entry.published.slice(0, 4)) : null
  return {
    doi: key,
    title: entry.title,
    authors: JSON.stringify(entry.authors),
    journal: entry.journalRef ?? 'arXiv',
    issn: null,
    eissn: null,
    publication_date: entry.published.length >= 10 ? entry.published.slice(0, 10) : null,
    year,
    abstract: entry.summary.length > 0 ? entry.summary : null,
    url: entry.url,
    source: 'arxiv',
    is_open_access: 1,
    citation_count: 0,
  }
}

/** Canonical unique id for an arXiv entry: DOI when present, else `arxiv:...`. */
export function arxivUniqueId(entry: ArxivEntry): string {
  return entry.doi?.trim().length ? entry.doi.trim().toLowerCase() : `arxiv:${entry.id}`
}

/** arXiv author-search query builder: surname initial style is safest. */
export function arxivAuthorQuery(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 0) return ''
  const family = parts[parts.length - 1]
  const given = parts.slice(0, -1).map(part => part[0]).join('')
  return given.length > 0 ? `au:"${family}_${given}"` : `au:"${family}"`
}

export class ArxivClient implements ArxivSearchApi {
  readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(options: ArxivClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_ARXIV_BASE_URL).replace(/\/+$/u, '')
    this.timeoutMs = options.timeoutMs ?? 20_000
  }

  async search(params: ArxivSearchParams, signal?: AbortSignal): Promise<ArxivEntry[]> {
    const query = new URLSearchParams()
    query.set('search_query', params.query)
    query.set('start', '0')
    query.set('max_results', String(Math.min(params.maxResults ?? 30, 100)))
    if (params.sortBy !== undefined) query.set('sortBy', params.sortBy)
    if (params.sortOrder !== undefined) query.set('sortOrder', params.sortOrder)

    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}?${query.toString()}`, {
        headers: {
          Accept: 'application/atom+xml',
          'User-Agent': 'dsh-literature/0.1 (arxiv tracking search)',
        },
        signal: combined,
      })
    } catch (error) {
      if (combined.aborted && signal?.aborted) throw new ArxivError('request aborted', { cause: error })
      throw new ArxivError(`arXiv request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    if (!response.ok) {
      throw new ArxivError(`arXiv answered HTTP ${response.status}`, { status: response.status })
    }
    const xml = await response.text()
    const entries: ArxivEntry[] = []
    for (const block of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const raw = block[1]
      if (raw === undefined) continue
      const entry = parseArxivEntry(raw)
      if (entry === null) continue
      const date = entry.published.slice(0, 10)
      if (params.startDate !== undefined && (date.length === 0 || date < params.startDate)) continue
      if (params.endDate !== undefined && (date.length === 0 || date > params.endDate)) continue
      entries.push(entry)
    }
    return entries
  }
}
