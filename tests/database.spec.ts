import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { LiteratureDatabase, PAPER_CACHE_LIMIT } from '../src/db/database.ts'
import type { LibraryPaperInput, PaperInput } from '../src/db/types.ts'

const openDb = (): { db: LiteratureDatabase; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-literature-db-'))
  const db = new LiteratureDatabase(join(dir, 'literature.db'))
  db.open()
  return { db, dir }
}

const paper = (overrides: Partial<PaperInput> & Pick<PaperInput, 'doi' | 'title'>): PaperInput => ({
  source: 'crossref',
  ...overrides,
})

const cleanups: (() => void)[] = []
const useDb = (): { db: LiteratureDatabase; dir: string } => {
  const handle = openDb()
  cleanups.push(() => rmSync(handle.dir, { recursive: true, force: true }))
  return handle
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe('LiteratureDatabase', () => {
  it('creates the file, dir, and schema on open', () => {
    const { db, dir } = useDb()
    expect(db.isOpen).toBe(true)
    expect(db.stats().schemaVersion).toBe(4)
    expect(db.stats().paperCount).toBe(0)
    expect(db.stats().cacheCount).toBe(0)
    expect(db.stats().libraryCount).toBe(0)
    expect(db.stats().journalCount).toBe(0)
    expect(db.path.startsWith(dir)).toBe(true)
  })

  it('upserts papers and reads them back by DOI', () => {
    const { db } = useDb()
    db.upsertPaper(paper({ doi: '10.1000/one', title: 'First paper' }))
    expect(db.countPapers()).toBe(1)
    const record = db.getPaper('10.1000/one')
    expect(record?.title).toBe('First paper')
    expect(record?.authors).toBe('[]')
    expect(record?.is_open_access).toBe(0)
    // Upserting the same DOI updates rather than duplicates.
    db.upsertPaper(paper({ doi: '10.1000/one', title: 'First paper, revised', year: 2024 }))
    expect(db.countPapers()).toBe(1)
    expect(db.getPaper('10.1000/one')?.year).toBe(2024)
  })

  it('finds papers through FTS5 phrase-AND search with relevance order', () => {
    const { db } = useDb()
    db.upsertPaper(paper({ doi: '10.1000/a', title: 'CRISPR off-target detection methods', abstract: 'a review of detection' }))
    db.upsertPaper(paper({ doi: '10.1000/b', title: 'Deep learning for protein folding', abstract: 'neural networks' }))
    db.upsertPaper(paper({ doi: '10.1000/c', title: 'CRISPR protein engineering', abstract: 'unrelated' }))
    const hits = db.searchPapers({ query: 'crispr detection' })
    expect(hits.map(hit => hit.doi)).toContain('10.1000/a')
    expect(hits.map(hit => hit.doi)).not.toContain('10.1000/b')
    // Strict AND on two tokens: only the paper with both.
    expect(hits.map(hit => hit.doi)).not.toContain('10.1000/c')
  })

  it('falls back to substring search when FTS5 finds nothing or query is CJK', () => {
    const { db } = useDb()
    // The token "conduct" only exists inside the compound token
    // "superconductivity": FTS5 yields nothing, the LIKE scan recovers it.
    db.upsertPaper(paper({ doi: '10.1000/a', title: 'Superconductivity at room temperature' }))
    const recovered = db.searchPapers({ query: 'conduct' })
    expect(recovered.map(hit => hit.doi)).toContain('10.1000/a')
    // CJK query skips FTS5 entirely and matches by substring.
    db.upsertPaper(paper({ doi: '10.1000/b', title: '机器学习综述', abstract: '神经网络' }))
    const cjk = db.searchPapers({ query: '机器学习' })
    expect(cjk.map(hit => hit.doi)).toContain('10.1000/b')
  })

  it('applies year, journal, source, open-access, and citation filters', () => {
    const { db } = useDb()
    db.upsertPaper(paper({ doi: '10.1000/a', title: 'T A', journal: 'Nature', year: 2023, is_open_access: 1, citation_count: 10 }))
    db.upsertPaper(paper({ doi: '10.1000/b', title: 'T B', journal: 'Science', year: 2019, is_open_access: 0, citation_count: 5 }))
    db.upsertPaper(paper({ doi: '10.1000/c', title: 'T C', journal: 'Nature Physics', year: 2025, is_open_access: 1, citation_count: 2, source: 'manual' }))

    // Filtered scans order by year desc (newest first).
    expect(db.searchPapers({ fromYear: 2020 }).map(r => r.doi)).toEqual(['10.1000/c', '10.1000/a'])
    expect(db.searchPapers({ toYear: 2020 }).map(r => r.doi)).toEqual(['10.1000/b'])
    expect(db.searchPapers({ journal: 'Nature' }).map(r => r.doi)).toEqual(['10.1000/c', '10.1000/a'])
    expect(db.searchPapers({ openAccess: true, minCitations: 5 }).map(r => r.doi)).toEqual(['10.1000/a'])
    expect(db.searchPapers({ source: 'manual' }).map(r => r.doi)).toEqual(['10.1000/c'])
    expect(db.searchPapers({ query: 'T', limit: 2 })).toHaveLength(2)
  })

  it('combines an FTS query with column filters (no ambiguous column names)', () => {
    const { db } = useDb()
    db.upsertPaper(paper({ doi: '10.1000/a', title: 'CRISPR review', journal: 'Nature', year: 2024, citation_count: 8 }))
    db.upsertPaper(paper({ doi: '10.1000/b', title: 'CRISPR guide design', journal: 'Science', year: 2024, citation_count: 1 }))
    // query + journal goes through the FTS branch where papers and
    // papers_fts share column names like `journal` and `year`.
    expect(db.searchPapers({ query: 'crispr', journal: 'Nature' }).map(r => r.doi)).toEqual(['10.1000/a'])
    expect(db.searchPapers({ query: 'crispr', fromYear: 2024 }).map(r => r.doi).sort()).toEqual(['10.1000/a', '10.1000/b'])
    expect(db.searchPapers({ query: 'crispr', minCitations: 5 }).map(r => r.doi)).toEqual(['10.1000/a'])
  })

  it('deletes papers and keeps journals separate', () => {
    const { db } = useDb()
    db.upsertPaper(paper({ doi: '10.1000/a', title: 'Paper A' }))
    db.upsertJournal({ id: '0028-0836', journal_title: 'Nature', impact_factor: 50.5 })
    expect(db.deletePaper('10.1000/a')).toBe(true)
    expect(db.deletePaper('10.1000/missing')).toBe(false)
    expect(db.countPapers()).toBe(0)
    expect(db.countJournals()).toBe(1)
    expect(db.getJournal('0028-0836')?.impact_factor).toBe(50.5)
    expect(db.searchJournals('nature').map(j => j.id)).toEqual(['0028-0836'])
  })

  it('imports a batch transactionally and reports per-record failures', () => {
    const { db } = useDb()
    const result = db.importPapers([
      paper({ doi: '10.1000/a', title: 'Imported A' }),
      paper({ doi: '', title: 'Broken' }),
      { doi: '10.1000/b', title: '' },
    ])
    expect(result.imported).toBe(1)
    expect(result.failed).toBe(2)
    expect(db.countLibraryPapers()).toBe(1)
    expect(db.countPapers()).toBe(0)
    // Re-importing an existing unique id counts as skipped.
    const again = db.importPapers([paper({ doi: '10.1000/a', title: 'Imported A' })])
    expect(again.skipped).toBe(1)
  })

  it('backs up, exports, and vacuums', () => {
    const { db, dir } = useDb()
    db.importPapers([paper({ doi: '10.1000/a', title: 'Exportable' })])
    const backupPath = db.backup(join(dir, 'backup.db'))
    expect(readFileSync(backupPath).length).toBeGreaterThan(0)
    const exported = db.exportToJson(join(dir, 'all.json'))
    expect(exported.count).toBe(1)
    const document = JSON.parse(readFileSync(exported.path, 'utf8')) as { library: unknown[]; papers: unknown[]; journals: unknown[] }
    expect(document.library).toHaveLength(1)
    expect(document.papers).toHaveLength(1)
    expect(document.journals).toHaveLength(0)
    db.vacuum()
    const stats = db.stats()
    expect(stats.sizeBytes).toBeGreaterThan(0)
    expect(stats.earliestYear).toBeNull()
    expect(stats.latestYear).toBeNull()
  })

  it('vacuum merges WAL frames into the main database file', () => {
    const { db } = useDb()
    db.upsertPaper(paper({ doi: '10.1000/wal', title: 'WAL resident' }))
    // An immutable open ignores the -wal file, i.e. it sees only what has
    // been merged into literature.db itself.
    const countMainOnly = (): number => {
      const ro = new DatabaseSync(`file:${db.path}?mode=ro&immutable=1`)
      try {
        const row = ro.prepare('SELECT COUNT(*) AS c FROM papers').get() as { c?: unknown } | undefined
        return Number(row?.c ?? 0)
      } catch (error) {
        // Before the checkpoint the main file may not even contain the
        // schema yet, which counts as "nothing merged".
        if (error instanceof Error && error.message.includes('no such table')) return 0
        throw error
      } finally {
        ro.close()
      }
    }
    expect(countMainOnly()).toBe(0)
    db.vacuum()
    expect(countMainOnly()).toBe(1)
  })

  it('survives close and reopen', () => {
    const { db, dir } = useDb()
    db.upsertPaper(paper({ doi: '10.1000/a', title: 'Persisted' }))
    db.close()
    expect(db.isOpen).toBe(false)
    const reopened = new LiteratureDatabase(join(dir, 'literature.db'))
    reopened.open()
    expect(reopened.getPaper('10.1000/a')?.title).toBe('Persisted')
    reopened.close()
  })

  it('returns empty results for an unknown search', () => {
    const { db } = useDb()
    db.upsertPaper(paper({ doi: '10.1000/a', title: 'Something' }))
    expect(db.searchPapers({ query: 'zzzz-no-match' })).toEqual([])
  })

  it(`prunes the papers cache down to ${PAPER_CACHE_LIMIT} oldest-updated rows`, () => {
    const { db } = useDb()
    for (let index = 0; index < PAPER_CACHE_LIMIT + 5; index += 1) {
      db.upsertPaper(paper({ doi: `10.1000/cache-${index}`, title: `Cache ${index}` }))
    }
    expect(db.countPapers()).toBe(PAPER_CACHE_LIMIT)
    expect(db.getPaper('10.1000/cache-0')).toBeNull()
    expect(db.getPaper(`10.1000/cache-${PAPER_CACHE_LIMIT + 4}`)).not.toBeNull()
  })

  it('copies cache metadata into the library and keeps the title after the cache row is gone', () => {
    const { db } = useDb()
    db.upsertPaper(paper({
      doi: '10.1000/lib',
      title: 'Library title',
      journal: 'Nature',
      year: 2026,
      abstract: 'kept',
    }))
    const created = db.curateFromCache('10.1000/lib', 'very_high', 'exact match', null)
    expect(created?.title).toBe('Library title')
    expect(db.getPaper('10.1000/lib')).toBeNull()
    expect(db.getLibraryPaper('10.1000/lib')?.title).toBe('Library title')
    expect(db.listLibraryPapers()[0]?.title).toBe('Library title')
    expect(db.curateFromCache('10.1000/lib', 'high', 'repeat')).toBeNull()
  })

  it('searches the library FTS and misses cache-only rows', () => {
    const { db } = useDb()
    db.upsertPaper(paper({ doi: '10.1000/cache-only', title: 'CRISPR cache only' }))
    db.upsertLibraryPaper({
      unique_id: '10.1000/library',
      title: 'CRISPR library hit',
      relevance: 'high',
    } satisfies LibraryPaperInput)
    expect(db.searchLibraryPapers({ query: 'crispr' }).map(row => row.unique_id)).toEqual(['10.1000/library'])
    expect(db.searchPapers({ query: 'crispr' }).map(row => row.doi)).toEqual(['10.1000/cache-only'])
  })

  it('migrates v3 curated_papers JOIN papers into one global library row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-literature-v3-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'literature.db')
    const raw = new DatabaseSync(path)
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE papers (
        doi TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '[]',
        journal TEXT, issn TEXT, eissn TEXT, publication_date TEXT, year INTEGER,
        abstract TEXT, url TEXT, source TEXT NOT NULL DEFAULT 'manual',
        is_open_access INTEGER NOT NULL DEFAULT 0, citation_count INTEGER NOT NULL DEFAULT 0,
        impact_factor REAL, cas_partition INTEGER, is_sci INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
        updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z'
      );
      CREATE TABLE tracking_plans (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('topic', 'person')),
        journal_whitelist TEXT, orcid TEXT,
        time_window_days INTEGER NOT NULL DEFAULT 7,
        search_interval_days INTEGER NOT NULL DEFAULT 7,
        enabled INTEGER NOT NULL DEFAULT 1, notes TEXT,
        created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
        updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z'
      );
      CREATE TABLE curated_papers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL REFERENCES tracking_plans(id) ON DELETE CASCADE,
        unique_id TEXT NOT NULL, relevance TEXT NOT NULL, note TEXT,
        added_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
        UNIQUE(plan_id, unique_id)
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '3');
      INSERT INTO tracking_plans (id, name, kind) VALUES ('plan-a', 'Topic A', 'topic');
      INSERT INTO tracking_plans (id, name, kind, orcid) VALUES ('plan-b', 'Person B', 'person', '0000-0002-0000-0001');
      INSERT INTO papers (doi, title, journal) VALUES ('10.1000/shared', 'Shared paper', 'Nature');
      INSERT INTO curated_papers (plan_id, unique_id, relevance, note)
        VALUES ('plan-a', '10.1000/shared', 'very_high', 'topic match');
      INSERT INTO curated_papers (plan_id, unique_id, relevance, note)
        VALUES ('plan-b', '10.1000/shared', 'medium', 'not first author');
    `)
    raw.close()

    const db = new LiteratureDatabase(path)
    db.open()
    expect(db.stats().schemaVersion).toBe(4)
    expect(db.countLibraryPapers()).toBe(1)
    const row = db.getLibraryPaper('10.1000/shared')
    expect(row?.title).toBe('Shared paper')
    expect(row?.relevance).toBe('very_high')
    expect(row?.note).toContain('topic match')
    expect(row?.note).toContain('not first author')
    db.close()
  })
})

describe('researcher profiles', () => {
  it('upserts by ORCID-derived id and keeps a Chinese display name', () => {
    const { db } = useDb()
    db.upsertResearcherProfile({
      id: 'profile-0000-0002-9019-5088',
      display_name: '段敬来 (Jinglai Duan)',
      orcid: '0000-0002-9019-5088',
      name_zh: '段敬来',
      family_name: 'Duan',
      given_name: 'Jinglai',
      research_areas: JSON.stringify([{ area: 'ion track', confidence: 0.9, evidence: 'ORCID titles' }]),
    })
    const found = db.findResearcherProfiles('0000-0002-9019-5088')
    expect(found).toHaveLength(1)
    expect(found[0]?.id).toBe('profile-0000-0002-9019-5088')
    expect(found[0]?.display_name).toBe('段敬来 (Jinglai Duan)')
    expect(db.findResearcherProfiles('段敬来').map(row => row.id)).toEqual(['profile-0000-0002-9019-5088'])
    expect(db.findResearcherProfiles('profile-0000-0002-9019-5088')).toHaveLength(1)
  })

  it('updates only supplied fields on a second upsert', () => {
    const { db } = useDb()
    db.upsertResearcherProfile({
      id: 'profile-0000-0002-9019-5088',
      display_name: 'Jinglai Duan',
      orcid: '0000-0002-9019-5088',
      notes: 'keep me',
      institution: 'IMP',
    })
    db.upsertResearcherProfile({
      id: 'profile-0000-0002-9019-5088',
      display_name: '段敬来 (Jinglai Duan)',
      orcid: '0000-0002-9019-5088',
      institution: 'Institute of Modern Physics, CAS',
    })
    const row = db.getResearcherProfileById('profile-0000-0002-9019-5088')
    expect(row?.display_name).toBe('段敬来 (Jinglai Duan)')
    expect(row?.institution).toBe('Institute of Modern Physics, CAS')
    expect(row?.notes).toBe('keep me')
  })

  it('lists, searches, and hides archived profiles from the default list', () => {
    const { db } = useDb()
    db.upsertResearcherProfile({
      id: 'profile-0000-0002-9019-5088',
      display_name: 'Jinglai Duan',
      orcid: '0000-0002-9019-5088',
      institution: 'Institute of Modern Physics',
      research_areas: JSON.stringify([{ area: 'ion track' }]),
    })
    db.upsertResearcherProfile({
      id: 'profile-0000-0001-9041-1468',
      display_name: 'Andrea Sand',
      orcid: '0000-0001-9041-1468',
      status: 'archived',
    })
    expect(db.listResearcherProfiles().map(row => row.orcid)).toEqual(['0000-0002-9019-5088'])
    expect(db.listResearcherProfiles('archived').map(row => row.orcid)).toEqual(['0000-0001-9041-1468'])
    expect(db.searchResearcherProfiles('ion track').map(row => row.id)).toEqual(['profile-0000-0002-9019-5088'])
    expect(db.searchResearcherProfiles('Andrea')).toEqual([])
  })

  it('returns every exact name match instead of picking the first', () => {
    const { db } = useDb()
    db.upsertResearcherProfile({
      id: 'profile-0000-0002-0000-0001',
      display_name: 'Li Wei',
      orcid: '0000-0002-0000-0001',
      name_zh: '李伟',
    })
    db.upsertResearcherProfile({
      id: 'profile-0000-0002-0000-0002',
      display_name: 'Li Wei',
      orcid: '0000-0002-0000-0002',
      name_zh: '李伟',
    })
    expect(db.findResearcherProfiles('Li Wei')).toHaveLength(2)
    expect(db.findResearcherProfiles('李伟')).toHaveLength(2)
  })

  it('nulls plan_id when the tracking plan is deleted and keeps the plan when the profile is deleted', () => {
    const { db } = useDb()
    db.upsertTrackingPlan({
      id: 'plan-jinglai-duan',
      name: 'Jinglai Duan',
      kind: 'person',
      orcid: '0000-0002-9019-5088',
    })
    db.upsertResearcherProfile({
      id: 'profile-0000-0002-9019-5088',
      display_name: 'Jinglai Duan',
      orcid: '0000-0002-9019-5088',
      plan_id: 'plan-jinglai-duan',
    })
    expect(db.getResearcherProfileById('profile-0000-0002-9019-5088')?.plan_id).toBe('plan-jinglai-duan')
    expect(db.deleteTrackingPlan('plan-jinglai-duan')).toBe(true)
    expect(db.getResearcherProfileById('profile-0000-0002-9019-5088')?.plan_id).toBeNull()

    db.upsertTrackingPlan({
      id: 'plan-andrea-sand',
      name: 'Andrea Sand',
      kind: 'person',
      orcid: '0000-0001-9041-1468',
    })
    db.upsertResearcherProfile({
      id: 'profile-0000-0001-9041-1468',
      display_name: 'Andrea Sand',
      orcid: '0000-0001-9041-1468',
      plan_id: 'plan-andrea-sand',
    })
    expect(db.deleteResearcherProfile('profile-0000-0001-9041-1468')).toBe(true)
    expect(db.getTrackingPlan('plan-andrea-sand')?.orcid).toBe('0000-0001-9041-1468')
  })

  it('survives close and reopen', () => {
    const { db, dir } = useDb()
    db.upsertResearcherProfile({
      id: 'profile-0000-0002-9019-5088',
      display_name: 'Jinglai Duan',
      orcid: '0000-0002-9019-5088',
    })
    db.close()
    const reopened = new LiteratureDatabase(join(dir, 'literature.db'))
    reopened.open()
    expect(reopened.getResearcherProfileById('profile-0000-0002-9019-5088')?.orcid).toBe('0000-0002-9019-5088')
    reopened.close()
  })
})
