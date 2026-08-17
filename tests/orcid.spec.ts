import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeOrcid,
  OrcidClient,
  OrcidError,
  parseExpandedResults,
  profileIdFromOrcid,
} from '../src/engine/orcid.ts'

const originalFetch = globalThis.fetch
const fetchMock = vi.fn<typeof fetch>()

function mockResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

afterEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = originalFetch
})

describe('normalizeOrcid', () => {
  it('uppercases the checksum X and rejects malformed values', () => {
    expect(normalizeOrcid('0000-0002-9019-5088')).toBe('0000-0002-9019-5088')
    expect(normalizeOrcid(' 0000-0002-1825-009x ')).toBe('0000-0002-1825-009X')
    expect(normalizeOrcid('0000000290195088')).toBeNull()
    expect(normalizeOrcid('not-an-orcid')).toBeNull()
  })
})

describe('parseExpandedResults', () => {
  it('flattens hyphenated ORCID keys and institution arrays', () => {
    const candidates = parseExpandedResults({
      'expanded-result': [
        {
          'orcid-id': '0000-0002-9019-5088',
          'given-names': 'Jinglai',
          'family-names': 'Duan',
          'institution-name': ['Institute of Modern Physics', 'UCAS'],
        },
        {
          'orcid-id': '0000-0002-1825-0097',
          'given-names': 'Jinglai',
          'family-names': 'Duan',
          'institution-name': 'Other Lab',
        },
        { 'orcid-id': 'bad', 'given-names': 'Skip', 'family-names': 'Me' },
      ],
    })
    expect(candidates).toEqual([
      {
        orcid: '0000-0002-9019-5088',
        given_names: 'Jinglai',
        family_names: 'Duan',
        institution_names: ['Institute of Modern Physics', 'UCAS'],
      },
      {
        orcid: '0000-0002-1825-0097',
        given_names: 'Jinglai',
        family_names: 'Duan',
        institution_names: ['Other Lab'],
      },
    ])
  })

  it('returns an empty list for a malformed payload', () => {
    expect(parseExpandedResults(null)).toEqual([])
    expect(parseExpandedResults({})).toEqual([])
  })
})

describe('OrcidClient', () => {
  it('sends User-Agent, mailto, and a lucene name query', async () => {
    globalThis.fetch = fetchMock
    fetchMock.mockResolvedValueOnce(mockResponse({
      'expanded-result': [{
        'orcid-id': '0000-0002-9019-5088',
        'given-names': 'Jinglai',
        'family-names': 'Duan',
        'institution-name': ['IMP'],
      }],
    }))
    const client = new OrcidClient({
      baseUrl: 'https://pub.orcid.org/v3.0',
      mailto: 'researcher@example.com',
    })
    const hits = await client.expandedSearch({
      familyName: 'Duan',
      givenName: 'Jinglai',
      affiliation: 'Institute of Modern Physics',
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.orcid).toBe('0000-0002-9019-5088')
    const url = fetchMock.mock.calls[0]?.[0]
    expect(url).toBeTypeOf('string')
    const parsed = new URL(url as string)
    expect(parsed.pathname).toBe('/v3.0/expanded-search/')
    expect(parsed.searchParams.get('q')).toBe(
      'family-name:Duan AND given-names:Jinglai AND affiliation-org-name:Institute of Modern Physics',
    )
    expect(parsed.searchParams.get('mailto')).toBe('researcher@example.com')
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined
    expect(headers?.['User-Agent']).toContain('dsh-literature')
    expect(headers?.['User-Agent']).toContain('researcher@example.com')
  })

  it('maps HTTP failures to OrcidError without retrying client errors', async () => {
    globalThis.fetch = fetchMock
    fetchMock.mockResolvedValueOnce(mockResponse({}, 400))
    const client = new OrcidClient({ baseUrl: 'https://pub.orcid.org/v3.0', maxRetries: 3 })
    await expect(client.expandedSearch({ familyName: 'Duan', givenName: 'Jinglai' })).rejects.toBeInstanceOf(OrcidError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('profileIdFromOrcid', () => {
  it('prefixes the hyphenated ORCID', () => {
    expect(profileIdFromOrcid('0000-0002-9019-5088')).toBe('profile-0000-0002-9019-5088')
  })
})
