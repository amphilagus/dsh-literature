/**
 * ORCID Public API client: expanded-search for name disambiguation.
 * Work-summary sync is intentionally out of P0.
 * @module @amphilagus/dsh-literature/engine/orcid
 */

/** Default ORCID Public API v3 root. */
export const DEFAULT_ORCID_BASE_URL = 'https://pub.orcid.org/v3.0'

/** Hyphenated ORCID, checksum digit or X. */
export const ORCID_PATTERN = /^\d{4}-\d{4}-\d{4}-\d{3}[0-9X]$/i

export interface OrcidClientOptions {
  /** API root, e.g. `https://pub.orcid.org/v3.0`. */
  baseUrl?: string
  /** Contact email, used in User-Agent (and optional mailto query). */
  mailto?: string
  /** Per-request timeout in ms; default 20000. */
  timeoutMs?: number
  /** Total attempts per request; default 3. */
  maxRetries?: number
}

export interface OrcidExpandedSearchParams {
  familyName: string
  givenName: string
  affiliation?: string
  rows?: number
}

/** One expanded-search hit after flattening ORCID's hyphenated JSON keys. */
export interface OrcidCandidate {
  orcid: string
  given_names: string
  family_names: string
  institution_names: string[]
}

export class OrcidError extends Error {
  readonly status: number | undefined

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'OrcidError'
    this.status = options.status
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Normalize a hyphenated ORCID; uppercase the checksum X. Null when malformed. */
export function normalizeOrcid(raw: string): string | null {
  const trimmed = raw.trim()
  if (!ORCID_PATTERN.test(trimmed)) return null
  const parts = trimmed.split('-')
  const last = parts[3]
  if (parts.length !== 4 || last === undefined) return null
  return `${parts[0]}-${parts[1]}-${parts[2]}-${last.toUpperCase()}`
}

/** Stable profile primary key: `profile-` + hyphenated ORCID. */
export function profileIdFromOrcid(orcid: string): string {
  return `profile-${orcid}`
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  if (typeof value === 'string' && value.length > 0) return [value]
  return []
}

/** Map an ORCID expanded-search JSON payload into candidates. */
export function parseExpandedResults(payload: unknown): OrcidCandidate[] {
  if (payload === null || typeof payload !== 'object') return []
  const raw = (payload as { 'expanded-result'?: unknown })['expanded-result']
  if (!Array.isArray(raw)) return []
  const candidates: OrcidCandidate[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const orcid = normalizeOrcid(asString(row['orcid-id']))
    if (orcid === null) continue
    candidates.push({
      orcid,
      given_names: asString(row['given-names']),
      family_names: asString(row['family-names']),
      institution_names: asStringList(row['institution-name']),
    })
  }
  return candidates
}

export class OrcidClient {
  readonly baseUrl: string
  private readonly mailto: string | undefined
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private lastRequestAt = 0

  constructor(options: OrcidClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_ORCID_BASE_URL).replace(/\/+$/u, '')
    this.mailto = options.mailto
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.maxRetries = Math.max(1, options.maxRetries ?? 3)
  }

  /** Name (+ optional affiliation) search over the public expanded-search index. */
  async expandedSearch(params: OrcidExpandedSearchParams, signal?: AbortSignal): Promise<OrcidCandidate[]> {
    const clauses = [
      `family-name:${params.familyName.trim()}`,
      `given-names:${params.givenName.trim()}`,
    ]
    const affiliation = params.affiliation?.trim()
    if (affiliation !== undefined && affiliation.length > 0) {
      clauses.push(`affiliation-org-name:${affiliation}`)
    }
    const query = new URLSearchParams()
    query.set('q', clauses.join(' AND '))
    query.set('rows', String(Math.min(params.rows ?? 10, 50)))
    const payload = await this.request('/expanded-search/', query, signal)
    return parseExpandedResults(payload)
  }

  private async request(
    path: string,
    params: URLSearchParams,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const query = params
    if (this.mailto !== undefined && this.mailto.trim().length > 0) {
      query.set('mailto', this.mailto.trim())
    }
    const url = `${this.baseUrl}${path}?${query.toString()}`

    let lastError: unknown
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
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
        if (combined.aborted && signal?.aborted) throw new OrcidError('request aborted', { cause: error })
        if (attempt + 1 < this.maxRetries) {
          await sleep(backoffMs(attempt), signal)
          continue
        }
        throw new OrcidError(`ORCID request failed: ${messageOf(error)}`, { cause: error })
      }

      if (response.ok) return await response.json()
      if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
        throw new OrcidError(`ORCID answered HTTP ${response.status}`, { status: response.status })
      }
      lastError = new OrcidError(`ORCID answered HTTP ${response.status}`, { status: response.status })
      if (attempt + 1 < this.maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'))
        await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter, 10) * 1000 : backoffMs(attempt), signal)
      }
    }
    throw new OrcidError(`ORCID request failed after ${this.maxRetries} attempts: ${messageOf(lastError)}`, { cause: lastError })
  }
}

function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt, 30) * 1000
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OrcidError('request aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new OrcidError('request aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
