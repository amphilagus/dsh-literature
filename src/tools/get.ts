/**
 * The `literature_get` tool: fetch full details for one paper by DOI, from
 * the curated library first and Crossref second (the fetch is stored in the
 * search cache, not the library).
 * @module @amphilagus/dsh-literature/tools/get
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PaperHit } from '../engine/types.ts'
import type { LiteratureService } from '../literature-service.ts'
import { digestPaper, renderJsonValue } from './render.ts'
import { PAPER_SCHEMA } from './schemas.ts'

export const LITERATURE_GET_TOOL_NAME = 'literature_get'

const GET_DESCRIPTION =
  'Fetch full details for one scientific paper by DOI, from the curated library when present, '
  + 'otherwise from the Crossref API (the fetch is stored into the search cache, not the library). Returns '
  + 'title, authors, journal, year, abstract, URL, open-access status, and citation count. Use after '
  + 'literature_search when a result needs its complete record. Screening a hit into the library is '
  + 'tracking_curate, not this tool.'

const GET_SUCCESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: true },
    cached: { type: 'boolean', required: true },
    paper: { required: true, ...PAPER_SCHEMA },
  },
} as const

const GET_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: false },
    code: {
      type: 'string',
      required: true,
      enum: ['invalid_doi', 'not_found', 'crossref_error', 'internal_error'],
    },
    message: { type: 'string', required: true },
  },
} as const

const GET_OUTPUT_SCHEMA = { oneOf: [GET_SUCCESS_SCHEMA, GET_ERROR_SCHEMA] } as const

interface GetSuccessValue {
  ok: true
  cached: boolean
  paper: PaperHit
}

function isGetSuccess(value: unknown): value is GetSuccessValue {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { ok?: unknown; cached?: unknown; paper?: unknown }
  return candidate.ok === true && typeof candidate.cached === 'boolean'
    && typeof candidate.paper === 'object' && candidate.paper !== null
}

function renderGetValue(_args: unknown, value: unknown): ContentBlock[] {
  if (!isGetSuccess(value)) return renderJsonValue(_args, value)
  const text = `Literature details for ${value.paper.doi} (${value.cached ? 'from curated library' : 'fetched from Crossref and staged in the search cache'}):\n\n${digestPaper(value.paper, 1)}`
  return [{ type: 'text', text }]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Register `literature_get` on the host context. */
export function registerLiteratureGetTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: LITERATURE_GET_TOOL_NAME,
    description: GET_DESCRIPTION,
    parameters: {
      doi: {
        type: 'string',
        required: true,
        description: 'The paper DOI, e.g. "10.1038/nature12373" (a full https://doi.org/ URL is also accepted).',
      },
      forceRemote: {
        type: 'boolean',
        description: 'Skip the curated library and always fetch from Crossref. Defaults to false.',
      },
    },
    output: { schema: GET_OUTPUT_SCHEMA, render: renderGetValue },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        return await service.engine.get(args.doi, args.forceRemote === true, exec.signal)
      } catch (error) {
        if (exec.signal.aborted) throw error
        return { ok: false as const, code: 'internal_error' as const, message: messageOf(error) }
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Literature get', kind: 'read', rawInput: args.doi }),
  }))
}
