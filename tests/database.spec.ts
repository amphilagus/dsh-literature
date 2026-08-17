import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { LiteratureDatabase } from '../src/db/database.ts'
import type { PaperInput } from '../src/db/types.ts'

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
    expect(db.stats().schemaVersion).toBe(2)
    expect(db.stats().paperCount).toBe(0)
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
    expect(db.countPapers()).toBe(1)
    // Re-importing an existing DOI counts as skipped.
    const again = db.importPapers([paper({ doi: '10.1000/a', title: 'Imported A' })])
    expect(again.skipped).toBe(1)
  })

  it('backs up, exports, and vacuums', () => {
    const { db, dir } = useDb()
    db.upsertPaper(paper({ doi: '10.1000/a', title: 'Exportable' }))
    const backupPath = db.backup(join(dir, 'backup.db'))
    expect(readFileSync(backupPath).length).toBeGreaterThan(0)
    const exported = db.exportToJson(join(dir, 'all.json'))
    expect(exported.count).toBe(1)
    const document = JSON.parse(readFileSync(exported.path, 'utf8')) as { papers: unknown[]; journals: unknown[] }
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
})
