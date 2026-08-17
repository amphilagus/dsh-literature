import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LiteratureDatabase } from '../src/db/database.ts'
import { LiteratureSearchEngine, toHit } from '../src/engine/engine.ts'
import type { CrossrefSearchApi, CrossrefWork } from '../src/engine/crossref.ts'

const work = (overrides: Partial<Omit<CrossrefWork, 'title'>> & { DOI: string; title: string }): CrossrefWork => {
  const { title, ...rest } = overrides
  return { 'is-referenced-by-count': 0, title: [title], ...rest }
}

function stubCrossref(works: CrossrefWork[], total = works.length): CrossrefSearchApi {
  return {
    async searchWorks() {
      return { works, total }
    },
    async getWork(doi) {
      return works.find(entry => entry.DOI === doi) ?? null
    },
  }
}

const cleanups: (() => void)[] = []
const useEngine = (remote: CrossrefSearchApi, cacheRemote = true): LiteratureSearchEngine => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-literature-engine-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const db = new LiteratureDatabase(join(dir, 'literature.db'))
  db.open()
  return new LiteratureSearchEngine(db, remote, { cacheRemote })
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe('LiteratureSearchEngine', () => {
  it('merges local and Crossref results, deduplicating by DOI with local winning', async () => {
    const remote = stubCrossref([
      work({ DOI: '10.1000/shared', title: 'Shared from Crossref' }),
      work({ DOI: '10.1000/remote', title: 'Remote only' }),
    ])
    const engine = useEngine(remote)
    engine.db.upsertPaper({
      doi: '10.1000/shared',
      title: 'Shared from local cache',
      authors: JSON.stringify(['Local Author']),
      year: 2023,
    })

    const result = await engine.search('shared')
    if (!result.ok) throw new Error('expected success')
    expect(result.papers.map(paper => paper.doi)).toEqual(['10.1000/shared', '10.1000/remote'])
    const shared = result.papers.find(paper => paper.doi === '10.1000/shared')
    expect(shared?.title).toBe('Shared from local cache')
    expect(shared?.source).toBe('local')
    expect(result.sources).toEqual(['local', 'crossref'])
    expect(result.warnings).toEqual([])
  })

  it('caches remote hits into the database by default', async () => {
    const remote = stubCrossref([work({ DOI: '10.1000/remote', title: 'Cached remote' })])
    const engine = useEngine(remote, true)
    await engine.search('remote', { sources: 'crossref' })
    expect(engine.db.getPaper('10.1000/remote')?.title).toBe('Cached remote')
  })

  it('respects cacheRemote: false', async () => {
    const remote = stubCrossref([work({ DOI: '10.1000/remote', title: 'Uncached remote' })])
    const engine = useEngine(remote, false)
    await engine.search('remote', { sources: 'crossref' })
    expect(engine.db.getPaper('10.1000/remote')).toBeNull()
  })

  it('forwards the journal filter to Crossref as container-title', async () => {
    let captured: { filter: string | undefined } = { filter: undefined }
    const capturing: CrossrefSearchApi = {
      async searchWorks(params) {
        captured = { filter: params.filter }
        return { works: [], total: 0 }
      },
      async getWork() {
        return null
      },
    }
    const engine = useEngine(capturing)
    const result = await engine.search('quantum', {
      sources: 'crossref',
      journal: 'Physical Review Letters',
      fromYear: 2026,
      toYear: 2026,
    })
    if (!result.ok) throw new Error('expected success')
    expect(captured.filter).toContain('container-title:Physical Review Letters')
    expect(captured.filter).toContain('from-pub-date:2026-01-01')
    expect(captured.filter).toContain('until-pub-date:2026-12-31')
    expect(captured.filter).toContain('type:journal-article')
  })

  it('reports warnings instead of failing when Crossref errors', async () => {
    const failing: CrossrefSearchApi = {
      async searchWorks() {
        throw new Error('network down')
      },
      async getWork() {
        return null
      },
    }
    const engine = useEngine(failing)
    engine.db.upsertPaper({ doi: '10.1000/local', title: 'Only local' })
    const result = await engine.search('local', { sources: 'both' })
    if (!result.ok) throw new Error('expected success')
    expect(result.papers).toHaveLength(1)
    expect(result.papers[0]?.source).toBe('local')
    expect(result.warnings.join(' ')).toContain('crossref search failed')
  })

  it('rejects an empty query', async () => {
    const engine = useEngine(stubCrossref([]))
    const result = await engine.search('   ')
    expect(result.ok).toBe(false)
  })

  it('sorts by date when requested', async () => {
    const remote = stubCrossref([
      work({ DOI: '10.1000/older', title: 'Older' }),
      work({ DOI: '10.1000/newer', title: 'Newer' }),
    ])
    const engine = useEngine(remote)
    engine.db.upsertPaper({ doi: '10.1000/older', title: 'Older', year: 2019 })
    engine.db.upsertPaper({ doi: '10.1000/newer', title: 'Newer', year: 2024 })
    const result = await engine.search('er', { sortBy: 'date', sources: 'local' })
    if (!result.ok) throw new Error('expected success')
    expect(result.papers.map(paper => paper.year)).toEqual([2024, 2019])
  })

  it('looks up DOIs local-first, then Crossref with caching', async () => {
    const remote = stubCrossref([work({ DOI: '10.1000/fresh', title: 'Fresh fetch' })])
    const engine = useEngine(remote)
    const first = await engine.get('10.1000/fresh', false)
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.cached).toBe(false)
    const again = await engine.get('10.1000/fresh', false)
    if (!again.ok) throw new Error('expected success')
    expect(again.cached).toBe(true)
    expect(again.paper.title).toBe('Fresh fetch')
  })

  it('normalizes DOIs, rejects invalid ones, and maps 404 to not_found', async () => {
    const remote = stubCrossref([work({ DOI: '10.1000/present', title: 'Present' })])
    const engine = useEngine(remote)
    const invalid = await engine.get('not a doi')
    expect(invalid).toMatchObject({ ok: false, code: 'invalid_doi' })
    const missing = await engine.get('10.1000/absent')
    expect(missing).toMatchObject({ ok: false, code: 'not_found' })
    const present = await engine.get('https://doi.org/10.1000/present')
    expect(present.ok).toBe(true)
  })

  it('projects stored records into model-facing hits', () => {
    const engine = useEngine(stubCrossref([]))
    engine.db.upsertPaper({
      doi: '10.1000/a',
      title: 'Hit me',
      authors: JSON.stringify(['A', 'B']),
      is_open_access: 1,
      citation_count: 7,
      year: 2022,
    })
    const record = engine.db.getPaper('10.1000/a')
    expect(record).not.toBeNull()
    const hit = record === null ? null : toHit(record, 'local')
    expect(hit).toMatchObject({
      doi: '10.1000/a',
      authors: ['A', 'B'],
      openAccess: true,
      citations: 7,
      year: 2022,
      source: 'local',
    })
  })
})
