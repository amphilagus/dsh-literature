/**
 * `ctx.literature` service: owns the local SQLite database and the Crossref
 * search engine, exposed to tools and to other plugins through one Cordis key.
 * @module @amphilagus/dsh-literature/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { bundledSciJournalsPath, installSciJournalsCatalog, SciJournalCatalog } from './db/catalog.ts'
import { LiteratureDatabase } from './db/database.ts'
import { ArxivClient, DEFAULT_ARXIV_BASE_URL } from './engine/arxiv.ts'
import { CrossrefClient, DEFAULT_CROSSREF_BASE_URL } from './engine/crossref.ts'
import { LiteratureSearchEngine } from './engine/engine.ts'
import { TrackingSearchEngine } from './engine/tracking-engine.ts'

/** Default database location: `$DSH_HOME/data/literature/literature.db`. */
export function defaultDbPath(): string {
  return dshHomePath('data', 'literature', 'literature.db')
}

export { DEFAULT_CROSSREF_BASE_URL, DEFAULT_ARXIV_BASE_URL }

/** Plugin configuration; every field is optional with a production default. */
export interface LiteratureConfig {
  /**
   * Master switch. Default false: the host bundle stays inert so other
   * presets do not see literature/tracking tools. The 文献跟踪助理 preset
   * remounts this plugin with `enabled: true`.
   */
  enabled?: boolean
  /** SQLite database path; default `$DSH_HOME/data/literature/literature.db`. */
  dbPath?: string
  /** Bundled SCI journal catalog path; default `data/sci_journals.db` in this package. */
  sciJournalsPath?: string
  /** Polite-pool email sent with every Crossref request. */
  mailto?: string
  /** Crossref works API base URL. */
  crossrefBaseUrl?: string
  /** arXiv export API base URL. */
  arxivBaseUrl?: string
  /** Store Crossref hits into the local database. Default true. */
  cacheRemote?: boolean
  /** Per-request remote timeout in ms. Default 15000. */
  remoteTimeoutMs?: number
}

export class LiteratureService extends Service {
  /** The literature database manager. */
  readonly db: LiteratureDatabase
  /** The merged local + Crossref search engine. */
  readonly engine: LiteratureSearchEngine
  /** The Crossref client backing both engines. */
  readonly crossref: CrossrefClient
  /** The arXiv client backing the tracking engine. */
  readonly arxiv: ArxivClient
  /** The literature-tracking dual-source engine (Crossref + arXiv). */
  readonly tracking: TrackingSearchEngine
  /** Bundled SCI journal catalog (ISSN / eISSN, CAS partition, impact factor). */
  readonly catalog: SciJournalCatalog

  constructor(ctx: Context, config: LiteratureConfig = {}) {
    super(ctx, 'literature')
    const dbPath = resolveDbPath(config.dbPath)
    this.db = new LiteratureDatabase(dbPath)
    this.crossref = new CrossrefClient({
      baseUrl: config.crossrefBaseUrl ?? DEFAULT_CROSSREF_BASE_URL,
      ...config.mailto !== undefined && config.mailto.trim().length > 0 ? { mailto: config.mailto } : {},
      timeoutMs: config.remoteTimeoutMs ?? 20_000,
    })
    this.arxiv = new ArxivClient({
      baseUrl: config.arxivBaseUrl ?? DEFAULT_ARXIV_BASE_URL,
      timeoutMs: config.remoteTimeoutMs ?? 20_000,
    })
    this.engine = new LiteratureSearchEngine(
      this.db,
      this.crossref,
      { cacheRemote: config.cacheRemote ?? true },
    )
    this.tracking = new TrackingSearchEngine(
      this.db,
      this.crossref,
      this.arxiv,
      { cacheRemote: config.cacheRemote ?? true },
    )
    this.db.open()
    const catalogSource = config.sciJournalsPath?.trim() || bundledSciJournalsPath()
    const catalogPath = installSciJournalsCatalog(this.db.dataDir, catalogSource)
    this.catalog = new SciJournalCatalog(catalogPath)
    this.catalog.open()
    ctx.effect(() => () => {
      this.catalog.close()
      this.db.close()
    })
  }
}

function resolveDbPath(configured: string | undefined): string {
  const raw = configured?.trim()
  if (raw === undefined || raw.length === 0) return defaultDbPath()
  return expandHomePath(raw)
}
