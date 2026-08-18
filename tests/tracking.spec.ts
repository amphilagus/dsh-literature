/**
 * Literature-tracking tests: plan CRUD, global-library dedupe, search-log
 * lifecycle, and the candidate-id normalization helpers.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LiteratureDatabase } from '../src/db/database.ts'
import type { ArxivSearchApi } from '../src/engine/arxiv.ts'
import type { CrossrefSearchApi, CrossrefWork, SearchWorksParams } from '../src/engine/crossref.ts'
import { normalizeCandidateId, TrackingSearchEngine } from '../src/engine/tracking-engine.ts'
import { planNamesSimilar } from '../src/tools/tracking.ts'

const cleanups: (() => void)[] = []
const tmpDb = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-literature-tracking-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'literature.db')
}

function seededDb(): LiteratureDatabase {
  const db = new LiteratureDatabase(tmpDb())
  db.open()
  db.upsertPaper({ doi: '10.1000/paper-b', title: 'Paper B', year: 2026, source: 'crossref' })
  db.upsertPaper({ doi: 'arxiv:2607.01016', title: 'Track theory in Al2O3', year: 2026, source: 'arxiv' })
  return db
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe('tracking plan CRUD', () => {
  it('adds, lists, and removes plans; persons require orcid by convention', () => {
    const db = seededDb()
    db.upsertTrackingPlan({
      id: 'plan-shi-theory',
      name: 'SHI irradiation theory',
      kind: 'topic',
      journal_whitelist: JSON.stringify(['0168-583X', '2469-9969']),
      time_window_days: 7,
    })
    db.upsertTrackingPlan({
      id: 'plan-andrea-sand',
      name: 'Andrea Sand',
      kind: 'person',
      orcid: '0000-0001-9041-1468',
      time_window_days: 30,
    })
    expect(db.listTrackingPlans().map(plan => plan.id)).toEqual(
      expect.arrayContaining(['plan-shi-theory', 'plan-andrea-sand']),
    )
    expect(db.getTrackingPlan('Andrea Sand')?.orcid).toBe('0000-0001-9041-1468')
    expect(db.deleteTrackingPlan('plan-shi-theory')).toBe(true)
    expect(db.getTrackingPlan('plan-shi-theory')).toBeNull()
    db.close()
  })
})

describe('curated library dedupe semantics', () => {
  it('stores one global library row per unique_id across topic and person plans', () => {
    const db = seededDb()
    db.upsertTrackingPlan({ id: 'plan-a', name: 'Direction A', kind: 'topic' })
    db.upsertTrackingPlan({ id: 'plan-xiaoming', name: 'Xiaoming', kind: 'person', orcid: '0000-0002-0000-0001' })

    const first = db.curateFromCache('10.1000/paper-b', 'very_high', 'first author, exact match', 'plan-a')
    expect(first).not.toBeNull()
    expect(db.curateFromCache('10.1000/paper-b', 'high', 'repeat', 'plan-a')).toBeNull()
    expect(db.curateFromCache('10.1000/paper-b', 'medium', 'not first/corresponding author', 'plan-xiaoming')).toBeNull()

    expect(db.libraryUniqueIds()).toEqual(new Set(['10.1000/paper-b']))
    expect(db.listLibraryPapers()).toHaveLength(1)
    expect(db.listLibraryPapers()[0]?.title).toBe('Paper B')
    expect(db.countLibraryPapers()).toBe(1)
    expect(db.getPaper('10.1000/paper-b')).toBeNull()
    db.close()
  })

  it('supports arxiv: unique ids as library keys', () => {
    const db = seededDb()
    db.upsertTrackingPlan({ id: 'plan-t', name: 'Tracks', kind: 'topic' })
    const created = db.curateFromCache('arxiv:2607.01016', 'very_high', null, 'plan-t')
    expect(created).not.toBeNull()
    expect(db.listLibraryPapers()[0]?.title).toBe('Track theory in Al2O3')
    db.close()
  })
})

describe('search log lifecycle', () => {
  it('starts, completes once, and refuses double completion', () => {
    const db = seededDb()
    db.upsertTrackingPlan({ id: 'plan-a', name: 'Direction A', kind: 'topic' })
    const logId = db.startSearchLog('plan-a', '2026-08-10', '2026-08-17')
    expect(db.getSearchLog(logId)?.status).toBe('running')

    expect(db.completeSearchLog(logId, [
      { unique_id: '10.1000/paper-b', title: 'Paper B', url: 'https://doi.org/10.1000/paper-b', summary: 'Exact topic match, first author.' },
    ], 'One relevant paper this week.')).toBe(true)
    expect(db.completeSearchLog(logId, [], 'again')).toBe(false)

    const done = db.getSearchLog(logId)
    expect(done?.status).toBe('done')
    expect(done?.completed_at).not.toBeNull()
    expect(JSON.parse(done?.findings ?? '[]')).toHaveLength(1)
    expect(db.listSearchLogs('plan-a')).toHaveLength(1)
    db.close()
  })

  it('keeps library rows when a plan is removed; search logs still cascade', () => {
    const db = seededDb()
    db.upsertTrackingPlan({ id: 'plan-a', name: 'Direction A', kind: 'topic' })
    db.curateFromCache('10.1000/paper-b', 'high', null, 'plan-a')
    db.startSearchLog('plan-a', '2026-08-10', '2026-08-17')
    db.deleteTrackingPlan('plan-a')
    expect(db.countLibraryPapers()).toBe(1)
    expect(db.getLibraryPaper('10.1000/paper-b')?.source_plan_id).toBeNull()
    expect(db.listSearchLogs('plan-a')).toHaveLength(0)
    db.close()
  })
})

describe('candidate id normalization', () => {
  it('normalizes DOIs and arXiv ids into canonical unique ids', () => {
    expect(normalizeCandidateId('https://doi.org/10.1000/XYZ.123')).toBe('10.1000/xyz.123')
    expect(normalizeCandidateId('10.1000/XYZ.123')).toBe('10.1000/xyz.123')
    expect(normalizeCandidateId('2607.01016v2')).toBe('arxiv:2607.01016')
    expect(normalizeCandidateId('https://arxiv.org/abs/2607.01016')).toBe('arxiv:2607.01016')
    expect(normalizeCandidateId('nonsense')).toBeNull()
  })
})

describe('plan name similarity', () => {
  it('treats equal and mutually contained names as similar', () => {
    expect(planNamesSimilar('CRISPR', 'crispr')).toBe(true)
    expect(planNamesSimilar('CRISPR gene editing', 'CRISPR')).toBe(true)
    expect(planNamesSimilar('ion track', 'SHI irradiation')).toBe(false)
  })
})

const work = (overrides: Partial<Omit<CrossrefWork, 'title'>> & { DOI: string; title: string }): CrossrefWork => {
  const { title, ...rest } = overrides
  return { 'is-referenced-by-count': 0, title: [title], ...rest }
}

const emptyArxiv: ArxivSearchApi = {
  async search() {
    return []
  },
}

describe('tracking Crossref search paths', () => {
  it('uses a created-date retrieval net plus relevance and crops topic hits locally', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const [year, month, day] = today.split('-').map(Number)
    const windowStart = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)
    let captured: SearchWorksParams | undefined
    const crossref: CrossrefSearchApi = {
      async searchWorks(params) {
        captured = params
        return {
          works: [
            work({ DOI: '10.1000/old', title: 'Old topic', published: { 'date-parts': [[2019, 1, 1]] } }),
            work({ DOI: '10.1000/new', title: 'New topic', published: { 'date-parts': [[year, month, day]] } }),
          ],
          total: 2,
        }
      },
      async getWork() {
        return null
      },
    }
    const db = seededDb()
    db.upsertTrackingPlan({ id: 'plan-topic', name: 'crispr', kind: 'topic', time_window_days: 7 })
    const plan = db.getTrackingPlan('plan-topic')
    if (plan === null) throw new Error('expected plan')
    const engine = new TrackingSearchEngine(db, crossref, emptyArxiv, { cacheRemote: false })
    const outcome = await engine.searchPlan(plan)
    expect(captured?.sort).toBe('relevance')
    expect(captured?.filter).toBe(`from-created-date:${windowStart},type:journal-article`)
    expect(outcome.candidates.map(candidate => candidate.unique_id)).toEqual(['10.1000/new'])
    db.close()
  })

  it('keeps person searches on Crossref published + orcid + date window', async () => {
    let captured: SearchWorksParams | undefined
    const crossref: CrossrefSearchApi = {
      async searchWorks(params) {
        captured = params
        return { works: [], total: 0 }
      },
      async getWork() {
        return null
      },
    }
    const db = seededDb()
    db.upsertTrackingPlan({
      id: 'plan-person',
      name: 'Andrea Sand',
      kind: 'person',
      orcid: '0000-0001-9041-1468',
      time_window_days: 30,
    })
    const plan = db.getTrackingPlan('plan-person')
    if (plan === null) throw new Error('expected plan')
    const engine = new TrackingSearchEngine(db, crossref, emptyArxiv, { cacheRemote: false })
    await engine.searchPlan(plan)
    expect(captured?.sort).toBe('published')
    expect(captured?.order).toBe('desc')
    expect(captured?.filter).toContain('orcid:0000-0001-9041-1468')
    expect(captured?.filter).toMatch(/from-pub-date:\d{4}-\d{2}-\d{2}/)
    expect(captured?.filter).toMatch(/until-pub-date:\d{4}-\d{2}-\d{2}/)
    db.close()
  })

  it('excludes hits already present in the global library', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const [year, month, day] = today.split('-').map(Number)
    const crossref: CrossrefSearchApi = {
      async searchWorks() {
        return {
          works: [work({ DOI: '10.1000/new', title: 'New topic', published: { 'date-parts': [[year, month, day]] } })],
          total: 1,
        }
      },
      async getWork() {
        return null
      },
    }
    const db = seededDb()
    db.upsertTrackingPlan({ id: 'plan-topic', name: 'crispr', kind: 'topic', time_window_days: 7 })
    db.upsertPaper({ doi: '10.1000/new', title: 'New topic', year, source: 'crossref' })
    db.curateFromCache('10.1000/new', 'high', null, 'plan-topic')
    const plan = db.getTrackingPlan('plan-topic')
    if (plan === null) throw new Error('expected plan')
    const engine = new TrackingSearchEngine(db, crossref, emptyArxiv, { cacheRemote: false })
    const outcome = await engine.searchPlan(plan)
    expect(outcome.candidates).toEqual([])
    expect(outcome.excluded_already_curated).toEqual([{ unique_id: '10.1000/new', title: 'New topic' }])
    db.close()
  })
})
