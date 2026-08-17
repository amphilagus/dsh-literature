/**
 * The `literature_search` tool: search scientific literature across the curated
 * library and Crossref, merged by DOI.
 * @module @amphilagus/dsh-literature/tools/search
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PaperHit, SearchOptions } from '../engine/types.ts'
import type { LiteratureService } from '../literature-service.ts'
import { digestPaper, presentSearchCall, renderJsonValue } from './render.ts'
import { ERROR_SCHEMA, PAPER_SCHEMA } from './schemas.ts'

export const LITERATURE_SEARCH_TOOL_NAME = 'literature_search'

const SEARCH_DESCRIPTION =
  'Search scientific literature for research papers. Local queries (`sources=local` or `both`) search the '
  + 'curated library (full-text over title/abstract/journal/authors), not the remote-search cache. Remote '
  + 'queries use the Crossref scholarly API; those hits are staged in a cache until tracking_curate copies '
  + 'them into the library. Optional orcid restricts results to one researcher; optional recentDays keeps '
  + 'only papers from the last N days. Use fromYear/toYear for a calendar-year range, not a last-N-days '
  + 'window. Follow up with literature_get for a specific DOI.'

const SEARCH_SUCCESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: true },
    query: { type: 'string', required: true },
    sources: { type: 'array', required: true, items: { type: 'string', enum: ['local', 'crossref'] } },
    total: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
    papers: { type: 'array', required: true, items: PAPER_SCHEMA },
  },
} as const

const SEARCH_OUTPUT_SCHEMA = { oneOf: [SEARCH_SUCCESS_SCHEMA, ERROR_SCHEMA] } as const

function isSearchSuccess(value: unknown): value is {
  ok: true
  query: string
  sources: string[]
  total: number
  truncated: boolean
  warnings: string[]
  papers: PaperHit[]
} {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { ok?: unknown; papers?: unknown; query?: unknown; sources?: unknown; total?: unknown; truncated?: unknown; warnings?: unknown }
  return candidate.ok === true
    && typeof candidate.query === 'string'
    && Array.isArray(candidate.papers)
    && Array.isArray(candidate.sources)
    && typeof candidate.total === 'number'
    && typeof candidate.truncated === 'boolean'
    && Array.isArray(candidate.warnings)
}

/** Native mode sees a readable digest; the canonical JSON value stays intact. */
function renderSearchValue(_args: unknown, value: unknown): ContentBlock[] {
  if (!isSearchSuccess(value)) return renderJsonValue(_args, value)
  const lines = value.papers.map((paper, index) => digestPaper(paper, index + 1))
  const truncation = value.truncated ? ' (result list truncated; narrow the query or raise limit for more)' : ''
  const warningNote = value.warnings.length > 0 ? ` Warnings: ${value.warnings.join('; ')}` : ''
  const head = `Literature search for "${value.query}": ${value.total} paper(s) from ${value.sources.join(' + ')}${truncation}.${warningNote}`
  return [{ type: 'text', text: [head, ...lines].join('\n\n') }]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Register `literature_search` on the host context. */
export function registerLiteratureSearchTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: LITERATURE_SEARCH_TOOL_NAME,
    description: SEARCH_DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Search query: topic keywords, a phrase, or a researcher name, e.g. "CRISPR off-target detection".',
      },
      limit: {
        type: 'integer',
        description: 'Maximum papers to return, between 1 and 50. Defaults to 20.',
      },
      sources: {
        type: 'string',
        enum: ['local', 'crossref', 'both'],
        description: 'Which backends to consult: the curated library (`local`), the Crossref API, or both. Defaults to "both". Local does not search the remote-search cache.',
      },
      fromYear: { type: 'integer', description: 'Only papers published in this calendar year or later. Not a last-N-days filter; use recentDays for that.' },
      toYear: { type: 'integer', description: 'Only papers published in this calendar year or earlier. Not a last-N-days filter; use recentDays for that.' },
      journal: { type: 'string', description: 'Restrict to a journal name (substring match, e.g. "Nature").' },
      openAccess: { type: 'boolean', description: 'Only open-access papers when true.' },
      minCitations: { type: 'integer', description: 'Only papers with at least this many citations.' },
      orcid: {
        type: 'string',
        description: 'Optional ORCID (0000-0000-0000-0000) to restrict results to that researcher.',
      },
      recentDays: {
        type: 'integer',
        description: 'Keep only papers from the last N days. Use this for last-week or last-day windows.',
      },
    },
    output: { schema: SEARCH_OUTPUT_SCHEMA, render: renderSearchValue },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const options: SearchOptions = {
        ...args.limit !== undefined ? { limit: args.limit } : {},
        ...args.sources !== undefined ? { sources: args.sources } : {},
        ...args.fromYear !== undefined ? { fromYear: args.fromYear } : {},
        ...args.toYear !== undefined ? { toYear: args.toYear } : {},
        ...args.journal !== undefined ? { journal: args.journal } : {},
        ...args.openAccess !== undefined ? { openAccess: args.openAccess } : {},
        ...args.minCitations !== undefined ? { minCitations: args.minCitations } : {},
        ...args.orcid !== undefined ? { orcid: args.orcid } : {},
        ...args.recentDays !== undefined ? { recentDays: args.recentDays } : {},
      }
      try {
        return await service.engine.search(args.query, options, exec.signal)
      } catch (error) {
        if (exec.signal.aborted) throw error
        return { ok: false, code: 'internal_error', message: messageOf(error) }
      }
    },
    presentCall: args => presentSearchCall(args.query),
  }))
}
