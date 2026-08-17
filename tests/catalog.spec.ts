import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledSciJournalsPath, installSciJournalsCatalog, SciJournalCatalog } from '../src/db/catalog.ts'

const cleanups: (() => void)[] = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe('SciJournalCatalog', () => {
  it('opens the bundled catalog and counts SCI journals', () => {
    const catalog = new SciJournalCatalog(bundledSciJournalsPath())
    catalog.open()
    cleanups.push(() => catalog.close())
    expect(catalog.count()).toBeGreaterThan(9000)
  })

  it('finds a journal by print ISSN', () => {
    const catalog = new SciJournalCatalog(bundledSciJournalsPath())
    catalog.open()
    cleanups.push(() => catalog.close())
    const hits = catalog.search({ query: '0168-583X' })
    expect(hits.some(hit => hit.issn === '0168-583X')).toBe(true)
  })

  it('ranks 物理 journals by CAS partition then impact factor', () => {
    const catalog = new SciJournalCatalog(bundledSciJournalsPath())
    catalog.open()
    cleanups.push(() => catalog.close())
    const hits = catalog.search({ query: '物理', limit: 5 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.casDiscipline).toContain('物理')
    expect(hits[0]?.casPartition).toBe(1)
    expect(hits[0]?.issn ?? hits[0]?.eissn).toBeTruthy()
  })

  it('installs a copy into the literature data directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-literature-catalog-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const dest = installSciJournalsCatalog(dir)
    const catalog = new SciJournalCatalog(dest)
    catalog.open()
    cleanups.push(() => catalog.close())
    expect(catalog.count()).toBeGreaterThan(9000)
  })
})
