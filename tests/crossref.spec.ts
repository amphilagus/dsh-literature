import { afterEach, describe, expect, it, vi } from 'vitest'
import { CrossrefClient, CrossrefError, normalizeDoi, stripJats, toPaperInput } from '../src/engine/crossref.ts'

const originalFetch = globalThis.fetch
const fetchMock = vi.fn<typeof fetch>()

function mockResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

afterEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = originalFetch
})

describe('normalizeDoi', () => {
  it('normalizes URLs, doi: prefixes, and casing', () => {
    expect(normalizeDoi('10.1038/Nature12373')).toBe('10.1038/nature12373')
    expect(normalizeDoi('https://doi.org/10.1038/nature12373')).toBe('10.1038/nature12373')
    expect(normalizeDoi('doi: 10.1038/nature12373')).toBe('10.1038/nature12373')
  })

  it('rejects malformed DOIs', () => {
    expect(normalizeDoi('')).toBeNull()
    expect(normalizeDoi('not-a-doi')).toBeNull()
    expect(normalizeDoi('11.1234/too-short-prefix')).toBeNull()
  })
})

describe('stripJats', () => {
  it('removes tags and unescapes entities', () => {
    const raw = '<jats:p>We study <jats:italic>X</jats:italic> &amp; Y&apos;s effect&nbsp;now.</jats:p>'
    expect(stripJats(raw)).toBe("We study X & Y's effect now.")
  })
})

describe('toPaperInput', () => {
  it('maps a Crossref work into a paper input', () => {
    const input = toPaperInput({
      DOI: '10.1038/nature12373',
      title: ['A great paper'],
      author: [{ given: 'Jane', family: 'Doe' }, { name: 'Org Consortium' }],
      'container-title': ['Nature'],
      ISSN: ['0028-0836'],
      'issn-type': [{ type: 'print', value: '0028-0836' }, { type: 'electronic', value: '1476-4687' }],
      published: { 'date-parts': [[2023, 5, 15]] },
      abstract: '<jats:p>Abstract <jats:bold>text</jats:bold></jats:p>',
      license: [{ URL: 'http://creativecommons.org/licenses/by/4.0' }],
      'is-referenced-by-count': 42,
    })
    expect(input).not.toBeNull()
    expect(input?.doi).toBe('10.1038/nature12373')
    expect(input?.authors).toBe(JSON.stringify(['Jane Doe', 'Org Consortium']))
    expect(input?.journal).toBe('Nature')
    expect(input?.issn).toBe('0028-0836')
    expect(input?.eissn).toBe('1476-4687')
    expect(input?.publication_date).toBe('2023-05-15')
    expect(input?.year).toBe(2023)
    expect(input?.abstract).toBe('Abstract text')
    expect(input?.is_open_access).toBe(1)
    expect(input?.citation_count).toBe(42)
    expect(input?.source).toBe('crossref')
  })

  it('returns null for a work without a DOI', () => {
    expect(toPaperInput({ title: ['No DOI'] })).toBeNull()
  })

  it('strips JATS/MathML markup from titles', () => {
    const input = toPaperInput({
      DOI: '10.1103/example',
      title: ['First Evidence of the Decay <mml:math><mi>X</mi></mml:math>'],
    })
    expect(input?.title).toBe('First Evidence of the Decay X')
  })
})

describe('CrossrefClient', () => {
  it('sends polite-pool identification and maps search pages', async () => {
    globalThis.fetch = fetchMock
    fetchMock.mockResolvedValueOnce(mockResponse({
      message: {
        items: [{ DOI: '10.1000/one', title: ['One'] }],
        'total-results': 1,
      },
    }))
    const client = new CrossrefClient({ baseUrl: 'https://api.crossref.org/works', mailto: 'researcher@example.com' })
    const page = await client.searchWorks({ query: 'crispr', rows: 5, sort: 'relevance' })
    expect(page.total).toBe(1)
    expect(page.works).toHaveLength(1)
    const url = fetchMock.mock.calls[0]?.[0]
    expect(url).toBeTypeOf('string')
    const parsed = new URL(url as string)
    expect(parsed.pathname).toBe('/works')
    expect(parsed.searchParams.get('query')).toBe('crispr')
    expect(parsed.searchParams.get('rows')).toBe('5')
    expect(parsed.searchParams.get('mailto')).toBe('researcher@example.com')
    // Field whitelist keeps the default `reference` arrays out of the payload.
    expect(parsed.searchParams.get('select')).toContain('is-referenced-by-count')
    expect(parsed.searchParams.get('select')).not.toContain('reference,')
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined
    expect(headers?.['User-Agent']).toContain('dsh-literature')
  })

  it('looks up a DOI under the works endpoint, not /works/works', async () => {
    globalThis.fetch = fetchMock
    fetchMock.mockResolvedValueOnce(mockResponse({ message: { DOI: '10.1000/found', title: ['Found'] } }))
    const client = new CrossrefClient({ baseUrl: 'https://api.crossref.org/works' })
    const work = await client.getWork('10.1000/found')
    expect(work?.DOI).toBe('10.1000/found')
    const url = fetchMock.mock.calls[0]?.[0]
    expect(url).toBeTypeOf('string')
    const parsed = new URL(url as string)
    // The DOI path segment is percent-encoded; Crossref accepts both forms.
    expect(decodeURIComponent(parsed.pathname)).toBe('/works/10.1000/found')
  })

  it('returns null for a 404 DOI lookup', async () => {
    globalThis.fetch = fetchMock
    fetchMock.mockResolvedValueOnce(mockResponse({}, 404))
    const client = new CrossrefClient({ baseUrl: 'https://api.crossref.org/works' })
    await expect(client.getWork('10.1000/missing')).resolves.toBeNull()
  })

  it('retries on 429 with retry-after, then succeeds', async () => {
    globalThis.fetch = fetchMock
    fetchMock
      .mockResolvedValueOnce(mockResponse({}, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(mockResponse({ message: { items: [], 'total-results': 0 } }))
    const client = new CrossrefClient({ baseUrl: 'https://api.crossref.org/works', maxRetries: 3 })
    const page = await client.searchWorks({ query: 'retry me' })
    expect(page.total).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after maxRetries with a CrossrefError', async () => {
    globalThis.fetch = fetchMock
    fetchMock.mockResolvedValue(mockResponse({}, 500))
    const client = new CrossrefClient({ baseUrl: 'https://api.crossref.org/works', maxRetries: 2, timeoutMs: 5000 })
    await expect(client.searchWorks({ query: 'fail' })).rejects.toBeInstanceOf(CrossrefError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry client errors', async () => {
    globalThis.fetch = fetchMock
    fetchMock.mockResolvedValueOnce(mockResponse({}, 400))
    const client = new CrossrefClient({ baseUrl: 'https://api.crossref.org/works', maxRetries: 3 })
    await expect(client.searchWorks({ query: 'bad' })).rejects.toThrow(/HTTP 400/u)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
