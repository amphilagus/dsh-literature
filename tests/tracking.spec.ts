/**
 * Literature-tracking tests: plan CRUD, curated-library dedupe semantics
 * (same direction unique, cross-direction allowed), search-log lifecycle,
 * and the candidate-id normalization helpers.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LiteratureDatabase } from '../src/db/database.ts'
import type { ArxivSearchApi } from '../src/engine/arxiv.ts'
import type { CrossrefSearchApi, CrossrefWork, SearchWorksParams } from '../src/engine/crossref.ts'
import { normalizeCandidateId, TrackingSearchEngine } from '../src/engine/tracking-engine.ts'

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
  it('curates one paper per direction but allows the same paper across directions', () => {
    const db = seededDb()
    db.upsertTrackingPlan({ id: 'plan-a', name: 'Direction A', kind: 'topic' })
    db.upsertTrackingPlan({ id: 'plan-xiaoming', name: 'Xiaoming', kind: 'person', orcid: '0000-0002-0000-0001' })

    // Direction A curates paper B at very_high.
    const first = db.curatePaper('plan-a', '10.1000/paper-b', 'very_high', 'first author, exact match')
    expect(first).not.toBeNull()
    // Same direction repeat -> null (first-pass dedupe foundation).
    expect(db.curatePaper('plan-a', '10.1000/paper-b', 'high', 'repeat')).toBeNull()
    // Cross-direction (Xiaoming) -> allowed, graded medium for non-first/corresponding author.
    const second = db.curatePaper('plan-xiaoming', '10.1000/paper-b', 'medium', 'not first/corresponding author')
    expect(second).not.toBeNull()
    expect(second?.relevance).toBe('medium')

    expect(db.curatedUniqueIds('plan-a')).toEqual(new Set(['10.1000/paper-b']))
    expect(db.curatedUniqueIds('plan-xiaoming')).toEqual(new Set(['10.1000/paper-b']))
    expect(db.listCuratedPapers('plan-a')).toHaveLength(1)
    expect(db.listCuratedPapers('plan-a')[0]?.title).toBe('Paper B')
    expect(db.countCuratedPapers()).toBe(2)
    db.close()
  })

  it('supports arxiv: unique ids as curated keys', () => {
    const db = seededDb()
    db.upsertTrackingPlan({ id: 'plan-t', name: 'Tracks', kind: 'topic' })
    const created = db.curatePaper('plan-t', 'arxiv:2607.01016', 'very_high', null)
    expect(created).not.toBeNull()
    expect(db.listCuratedPapers('plan-t')[0]?.title).toBe('Track theory in Al2O3')
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

  it('cascades logs and curated entries when a plan is removed', () => {
    const db = seededDb()
    db.upsertTrackingPlan({ id: 'plan-a', name: 'Direction A', kind: 'topic' })
    db.curatePaper('plan-a', '10.1000/paper-b', 'high', null)
    db.startSearchLog('plan-a', '2026-08-10', '2026-08-17')
    db.deleteTrackingPlan('plan-a')
    expect(db.countCuratedPapers()).toBe(0)
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
  it('uses relevance and crops topic hits locally without a Crossref date filter', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const [year, month, day] = today.split('-').map(Number)
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
    expect(captured?.filter).toBeUndefined()
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
})
