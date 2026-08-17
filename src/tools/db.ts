/**
 * The `literature_db` tool: manage the local literature database — stats,
 * local search, single-record lookup, import, delete, backup, export, vacuum.
 * All backup/export targets are confined to the literature data directory.
 * @module @amphilagus/dsh-literature/tools/db
 */

import { statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { toHit } from '../engine/engine.ts'
import type { PaperHit } from '../engine/types.ts'
import type { PaperInput } from '../db/types.ts'
import type { SciJournalHit } from '../db/catalog.ts'
import type { LiteratureService } from '../literature-service.ts'
import { renderJsonValue } from './render.ts'
import { PAPER_SCHEMA } from './schemas.ts'

export const LITERATURE_DB_TOOL_NAME = 'literature_db'

const DB_DESCRIPTION =
  'Manage the local literature database and the bundled SCI journal catalog. Actions: stats, '
  + 'search (local papers), journals (SCI catalog by title / ISSN / eISSN / CAS discipline), get, '
  + 'import, delete, backup, export, vacuum. Use journals to pick ISSN values for a tracking-plan '
  + 'whitelist. Backup/export targets stay inside the literature data directory.'

const IMPORT_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doi: { type: 'string', required: true },
    title: { type: 'string', required: true },
    authors: { type: 'array', items: { type: 'string' } },
    journal: { type: 'string' },
    issn: { type: 'string' },
    eissn: { type: 'string' },
    publicationDate: { type: 'string' },
    year: { type: 'integer' },
    abstract: { type: 'string' },
    url: { type: 'string' },
    source: { type: 'string' },
    openAccess: { type: 'boolean' },
    citations: { type: 'integer' },
    impactFactor: { type: 'number' },
    casPartition: { type: 'integer' },
    isSci: { type: 'boolean' },
  },
} as const

interface ImportItem {
  doi: string
  title: string
  authors?: string[]
  journal?: string
  issn?: string
  eissn?: string
  publicationDate?: string
  year?: number
  abstract?: string
  url?: string
  source?: string
  openAccess?: boolean
  citations?: number
  impactFactor?: number
  casPartition?: number
  isSci?: boolean
}

function toPaperInputFromItem(item: ImportItem): PaperInput {
  return {
    doi: item.doi,
    title: item.title,
    ...item.authors !== undefined ? { authors: JSON.stringify(item.authors) } : {},
    ...item.journal !== undefined ? { journal: item.journal } : {},
    ...item.issn !== undefined ? { issn: item.issn } : {},
    ...item.eissn !== undefined ? { eissn: item.eissn } : {},
    ...item.publicationDate !== undefined ? { publication_date: item.publicationDate } : {},
    ...item.year !== undefined ? { year: item.year } : {},
    ...item.abstract !== undefined ? { abstract: item.abstract } : {},
    ...item.url !== undefined ? { url: item.url } : {},
    ...item.source !== undefined ? { source: item.source } : {},
    ...item.openAccess !== undefined ? { is_open_access: item.openAccess ? 1 : 0 } : {},
    ...item.citations !== undefined ? { citation_count: item.citations } : {},
    ...item.impactFactor !== undefined ? { impact_factor: item.impactFactor } : {},
    ...item.casPartition !== undefined ? { cas_partition: item.casPartition } : {},
    ...item.isSci !== undefined ? { is_sci: item.isSci ? 1 : 0 } : {},
  }
}

const DB_STATS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: true },
    action: { type: 'string', required: true, const: 'stats' },
    dbPath: { type: 'string', required: true },
    sizeBytes: { type: 'integer', required: true },
    schemaVersion: { type: 'integer', required: true },
    paperCount: { type: 'integer', required: true },
    journalCount: { type: 'integer', required: true },
    earliestYear: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
    latestYear: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
  },
} as const

const DB_SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: true },
    action: { type: 'string', required: true, const: 'search' },
    query: { type: 'string', required: true },
    total: { type: 'integer', required: true },
    papers: { type: 'array', required: true, items: PAPER_SCHEMA },
  },
} as const

const DB_GET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: true },
    action: { type: 'string', required: true, const: 'get' },
    doi: { type: 'string', required: true },
    paper: { required: true, oneOf: [PAPER_SCHEMA, { type: 'null' }] },
  },
} as const

const DB_IMPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: true },
    action: { type: 'string', required: true, const: 'import' },
    imported: { type: 'integer', required: true },
    skipped: { type: 'integer', required: true },
    failed: { type: 'integer', required: true },
    errors: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const DB_DELETE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: true },
    action: { type: 'string', required: true, const: 'delete' },
    doi: { type: 'string', required: true },
    deleted: { type: 'boolean', required: true },
  },
} as const

const DB_BACKUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: true },
    action: { type: 'string', required: true, const: 'backup' },
    path: { type: 'string', required: true },
    sizeBytes: { type: 'integer', required: true },
  },
} as const

const DB_EXPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: true },
    action: { type: 'string', required: true, const: 'export' },
    path: { type: 'string', required: true },
    count: { type: 'integer', required: true },
  },
} as const

const DB_VACUUM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: true },
    action: { type: 'string', required: true, const: 'vacuum' },
  },
} as const

const DB_JOURNALS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: true },
    action: { type: 'string', required: true, const: 'journals' },
    query: { type: 'string', required: true },
    total: { type: 'integer', required: true },
    journals: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          issn: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          eissn: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          publisher: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          impactFactor: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
          casPartition: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          casDiscipline: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          webOfScienceCategories: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    },
  },
} as const

const DB_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: false },
    action: { type: 'string', required: true },
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const

const DB_OUTPUT_SCHEMA = {
  oneOf: [
    DB_STATS_SCHEMA,
    DB_SEARCH_SCHEMA,
    DB_JOURNALS_SCHEMA,
    DB_GET_SCHEMA,
    DB_IMPORT_SCHEMA,
    DB_DELETE_SCHEMA,
    DB_BACKUP_SCHEMA,
    DB_EXPORT_SCHEMA,
    DB_VACUUM_SCHEMA,
    DB_ERROR_SCHEMA,
  ],
} as const

type DbAction = 'stats' | 'search' | 'journals' | 'get' | 'import' | 'delete' | 'backup' | 'export' | 'vacuum'

/** The exact canonical outcome union, mirroring {@link DB_OUTPUT_SCHEMA}. */
type DbOutcome =
  | { ok: true; action: 'stats'; dbPath: string; sizeBytes: number; schemaVersion: number; paperCount: number; journalCount: number; earliestYear: number | null; latestYear: number | null }
  | { ok: true; action: 'search'; query: string; total: number; papers: PaperHit[] }
  | { ok: true; action: 'journals'; query: string; total: number; journals: SciJournalHit[] }
  | { ok: true; action: 'get'; doi: string; paper: PaperHit | null }
  | { ok: true; action: 'import'; imported: number; skipped: number; failed: number; errors: string[] }
  | { ok: true; action: 'delete'; doi: string; deleted: boolean }
  | { ok: true; action: 'backup'; path: string; sizeBytes: number }
  | { ok: true; action: 'export'; path: string; count: number }
  | { ok: true; action: 'vacuum' }
  | { ok: false; action: string; code: string; message: string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateLimit(value: number | undefined): number | string {
  if (value === undefined) return 20
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    return 'limit must be an integer between 1 and 50'
  }
  return value
}

function timestampName(): string {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/u, 'Z')
}

/**
 * Resolve a backup/export target: relative targets anchor at the literature
 * data directory; absolute targets must stay inside it.
 */
function resolveInsideTarget(dataDir: string, target: string | undefined, fallbackName: string):
  | { ok: true; path: string }
  | { ok: false; message: string } {
  const base = resolve(dataDir)
  const raw = target?.trim() ?? ''
  const candidate = raw.length === 0 ? join(base, fallbackName) : isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
  const inside = candidate === base || candidate.startsWith(base + sep)
  if (!inside) return { ok: false, message: `target must stay inside the literature data directory (${base})` }
  return { ok: true, path: candidate }
}

function requireDoi(doi: string | undefined): string | { ok: false; code: string; message: string } {
  const trimmed = doi?.trim() ?? ''
  if (trimmed.length === 0) {
    return { ok: false, code: 'invalid_doi', message: 'doi must be a non-empty string' }
  }
  return trimmed
}

/** Register `literature_db` on the host context. */
export function registerLiteratureDbTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: LITERATURE_DB_TOOL_NAME,
    description: DB_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['stats', 'search', 'journals', 'get', 'import', 'delete', 'backup', 'export', 'vacuum'],
        description: 'The management action to run.',
      },
      query: {
        type: 'string',
        description: 'Search keywords. For action "search": local papers. For action "journals": journal title, print ISSN, eISSN, or CAS discipline.',
      },
      doi: { type: 'string', description: 'Paper DOI; used by actions "get" and "delete".' },
      items: {
        type: 'array',
        description: 'Paper records to store; used by action "import".',
        items: IMPORT_ITEM_SCHEMA,
      },
      limit: { type: 'integer', description: 'Maximum results for actions "search" and "journals", between 1 and 50. Defaults to 20.' },
      target: {
        type: 'string',
        description: 'File name for actions "backup"/"export", relative to the literature data directory. Defaults to a timestamped name.',
      },
    },
    output: { schema: DB_OUTPUT_SCHEMA, render: renderJsonValue },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<DbOutcome> {
      void exec
      const action: DbAction = args.action
      try {
        switch (action) {
          case 'stats': {
            return { ok: true, action: 'stats', ...service.db.stats() }
          }
          case 'search': {
            const limit = validateLimit(args.limit)
            if (typeof limit !== 'number') {
              return { ok: false, action, code: 'invalid_limit', message: limit }
            }
            const query = args.query?.trim() ?? ''
            const records = service.db.searchPapers({ query, limit })
            return {
              ok: true,
              action: 'search',
              query,
              total: records.length,
              papers: records.map(record => toHit(record, 'local')),
            }
          }
          case 'journals': {
            const limit = validateLimit(args.limit)
            if (typeof limit !== 'number') {
              return { ok: false, action, code: 'invalid_limit', message: limit }
            }
            const query = args.query?.trim() ?? ''
            const journals = service.catalog.search({ query, limit })
            return { ok: true, action: 'journals', query, total: journals.length, journals }
          }
          case 'get': {
            const doi = requireDoi(args.doi)
            if (typeof doi !== 'string') return { ok: false, action, code: doi.code, message: doi.message }
            const record = service.db.getPaper(doi)
            return { ok: true, action: 'get', doi, paper: record === null ? null : toHit(record, 'local') }
          }
          case 'import': {
            const items = (args.items ?? []) as unknown as ImportItem[]
            if (items.length === 0) {
              return { ok: true, action: 'import', imported: 0, skipped: 0, failed: 0, errors: [] }
            }
            const result = service.db.importPapers(items.map(item => toPaperInputFromItem(item)))
            return { ok: true, action: 'import', ...result }
          }
          case 'delete': {
            const doi = requireDoi(args.doi)
            if (typeof doi !== 'string') return { ok: false, action, code: doi.code, message: doi.message }
            const deleted = service.db.deletePaper(doi)
            return { ok: true, action: 'delete', doi, deleted }
          }
          case 'backup': {
            const target = resolveInsideTarget(service.db.dataDir, args.target, `backup-${timestampName()}.db`)
            if (!target.ok) return { ok: false, action, code: 'invalid_path', message: target.message }
            const path = service.db.backup(target.path)
            return { ok: true, action: 'backup', path, sizeBytes: statSync(path).size }
          }
          case 'export': {
            const target = resolveInsideTarget(service.db.dataDir, args.target, `export-${timestampName()}.json`)
            if (!target.ok) return { ok: false, action, code: 'invalid_path', message: target.message }
            const exported = service.db.exportToJson(target.path)
            return { ok: true, action: 'export', path: exported.path, count: exported.count }
          }
          case 'vacuum': {
            service.db.vacuum()
            return { ok: true, action: 'vacuum' }
          }
          default: {
            return { ok: false, action, code: 'invalid_action', message: `unknown action ${String(action)}` }
          }
        }
      } catch (error) {
        return { ok: false, action, code: 'db_error', message: messageOf(error) }
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Literature database', kind: 'other', rawInput: args.action }),
  }))
}
