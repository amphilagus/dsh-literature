/**
 * Literature-tracking tools: manage the tracking-plan table, run one
 * direction's dual-source (Crossref + arXiv) windowed search with first-pass
 * dedupe against the global library, copy screened cache rows into that
 * library, and close the search log (the completion endpoint of every run).
 * @module @amphilagus/dsh-literature/tools/tracking
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CurationRelevance, SearchFinding } from '../db/types.ts'
import { normalizeCandidateId } from '../engine/tracking-engine.ts'
import { normalizeOrcid } from '../engine/orcid.ts'
import type { LiteratureService } from '../literature-service.ts'
import { renderJsonValue } from './render.ts'
import { ERROR_SCHEMA } from './schemas.ts'

export const TRACKING_PLAN_ADD_TOOL_NAME = 'tracking_plan_add'
export const TRACKING_PLAN_LIST_TOOL_NAME = 'tracking_plan_list'
export const TRACKING_PLAN_REMOVE_TOOL_NAME = 'tracking_plan_remove'
export const TRACKING_SEARCH_TOOL_NAME = 'tracking_search'
export const TRACKING_CURATE_TOOL_NAME = 'tracking_curate'
export const TRACKING_LOG_COMPLETE_TOOL_NAME = 'tracking_log_complete'
export const TRACKING_CURATED_LIST_TOOL_NAME = 'tracking_curated_list'
export const TRACKING_LOG_LIST_TOOL_NAME = 'tracking_log_list'

const ORCID_PATTERN = /^\d{4}-\d{4}-\d{4}-\d{3}[0-9X]$/i
const RELEVANCE_VALUES = ['very_high', 'high', 'medium', 'low'] as const

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asError(error: unknown): { ok: false; code: string; message: string } {
  return { ok: false, code: 'internal_error', message: messageOf(error) }
}

/** Lowercase and collapse whitespace for plan-name comparison. */
export function normalizePlanName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** True when two names are equal after normalize, or one contains the other. */
export function planNamesSimilar(left: string, right: string): boolean {
  const a = normalizePlanName(left)
  const b = normalizePlanName(right)
  if (a.length === 0 || b.length === 0) return false
  return a === b || a.includes(b) || b.includes(a)
}

// -------------------------------------------------------------- plan add

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    kind: { type: 'string', required: true, enum: ['topic', 'person'] },
    journal_whitelist: { required: true, oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
    orcid: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    time_window_days: { type: 'integer', required: true },
    search_interval_days: { type: 'integer', required: true },
    enabled: { type: 'integer', required: true },
    notes: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
} as const

export function registerTrackingPlanAddTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: TRACKING_PLAN_ADD_TOOL_NAME,
    description:
      'Add or update one literature-tracking direction (文献跟踪方案表). Similar names (or the same ORCID for '
      + '`person`) return `possible_duplicate` plus the existing list of that kind and do not write; call again '
      + 'with `confirm=true` after the user agrees. A `topic` direction tracks a research theme with an optional '
      + 'journal-whitelist (ISSN array) that filters Crossref results. A `person` direction tracks one researcher '
      + 'and REQUIRES their ORCID. `time_window_days` is the search window (e.g. 3/7/30 days); `search_interval_days` '
      + 'is the scheduling period the agent uses to renew the reminder. Use `notes` for English search keywords when '
      + 'the name is not English.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Direction name: the topic phrase (English preferred for remote search) or the researcher full name.',
      },
      kind: {
        type: 'string',
        required: true,
        enum: ['topic', 'person'],
        description: 'Whether this direction tracks a research topic or a specific researcher.',
      },
      journal_whitelist: {
        type: 'array',
        items: { type: 'string' },
        description: 'Topic directions only: ISSN strings (print or electronic) restricting Crossref results. Omit for no whitelist.',
      },
      orcid: {
        type: 'string',
        description: 'Person directions only: the ORCID, format 0000-0000-0000-0000. Required when kind=person.',
      },
      time_window_days: {
        type: 'integer',
        description: 'Search window in days (近3天=3, 近一周=7, 近一月=30). Defaults to 7.',
      },
      search_interval_days: {
        type: 'integer',
        description: 'Reminder renewal period in days. Defaults to 7.',
      },
      enabled: {
        type: 'integer',
        description: '1 to enable (default) or 0 to pause this direction.',
      },
      notes: {
        type: 'string',
        description: 'Optional notes, e.g. English search keywords or screening criteria.',
      },
      confirm: {
        type: 'boolean',
        description:
          'Set true to create the direction even when a similar name (or the same ORCID) already exists. '
          + 'Defaults to false: a possible duplicate returns the existing list of that kind without writing.',
      },
    },
    output: {
      schema: {
        oneOf: [
          PLAN_SCHEMA,
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true, const: false },
              code: { type: 'string', required: true, const: 'possible_duplicate' },
              message: { type: 'string', required: true },
              existing: { type: 'array', required: true, items: PLAN_SCHEMA },
            },
          },
          ERROR_SCHEMA,
        ],
      } as const,
      render: renderJsonValue,
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      try {
        const kind = args.kind
        if (kind === 'person') {
          const orcid = String(args.orcid ?? '').trim()
          if (!ORCID_PATTERN.test(orcid)) {
            return { ok: false, code: 'invalid_orcid', message: 'kind=person requires a valid ORCID (format 0000-0000-0000-0000).' }
          }
        }
        const whitelist = args.journal_whitelist
        if (kind === 'topic' && whitelist !== undefined && !Array.isArray(whitelist)) {
          return { ok: false, code: 'invalid_whitelist', message: 'journal_whitelist must be an array of ISSN strings.' }
        }
        const name = args.name.trim()
        const orcid = args.orcid !== undefined ? args.orcid.trim() : ''
        const confirm = args.confirm === true
        const id = `plan-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
        if (!confirm) {
          const sameKind = service.db.listTrackingPlans().filter(plan => plan.kind === kind)
          const duplicate = sameKind.some(plan => {
            if (plan.id === id) return false
            if (planNamesSimilar(plan.name, name)) return true
            if (kind === 'person' && orcid.length > 0 && plan.orcid !== null && plan.orcid.toLowerCase() === orcid.toLowerCase()) {
              return true
            }
            return false
          })
          if (duplicate) {
            return {
              ok: false as const,
              code: 'possible_duplicate' as const,
              message: `A similar ${kind} direction may already exist. Show the list, confirm with the user, then call again with confirm=true.`,
              existing: sameKind.map(plan => ({
                id: plan.id,
                name: plan.name,
                kind: plan.kind,
                journal_whitelist: plan.journal_whitelist === null ? null : JSON.parse(plan.journal_whitelist),
                orcid: plan.orcid,
                time_window_days: plan.time_window_days,
                search_interval_days: plan.search_interval_days,
                enabled: plan.enabled,
                notes: plan.notes,
              })),
            }
          }
        }
        service.db.upsertTrackingPlan({
          id,
          name,
          kind,
          ...whitelist !== undefined ? { journal_whitelist: JSON.stringify(whitelist) } : {},
          ...args.orcid !== undefined ? { orcid: args.orcid.trim() } : {},
          ...args.time_window_days !== undefined ? { time_window_days: args.time_window_days } : {},
          ...args.search_interval_days !== undefined ? { search_interval_days: args.search_interval_days } : {},
          ...args.enabled !== undefined ? { enabled: args.enabled === 0 ? 0 : 1 } : {},
          ...args.notes !== undefined ? { notes: args.notes } : {},
        })
        const plan = service.db.getTrackingPlan(id)
        if (plan === null) return { ok: false, code: 'plan_not_found', message: 'Plan vanished after upsert.' }
        if (kind === 'person' && plan.orcid !== null) {
          const linked = normalizeOrcid(plan.orcid)
          if (linked !== null) service.db.linkProfilePlanByOrcid(linked, plan.id)
        }
        return {
          id: plan.id,
          name: plan.name,
          kind: plan.kind,
          journal_whitelist: plan.journal_whitelist === null ? null : JSON.parse(plan.journal_whitelist),
          orcid: plan.orcid,
          time_window_days: plan.time_window_days,
          search_interval_days: plan.search_interval_days,
          enabled: plan.enabled,
          notes: plan.notes,
        }
      } catch (error) {
        return asError(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Add tracking direction', kind: 'edit', rawInput: args.name }),
  }))
}

// ------------------------------------------------------------- plan list

export function registerTrackingPlanListTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: TRACKING_PLAN_LIST_TOOL_NAME,
    description: 'List all literature-tracking directions (跟踪方案表) with their configuration and enabled state.',
    parameters: {},
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true, const: true },
              plans: { type: 'array', required: true, items: PLAN_SCHEMA },
            },
          },
          ERROR_SCHEMA,
        ],
      } as const,
      render: renderJsonValue,
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(_args, _exec) {
      try {
        const plans = service.db.listTrackingPlans().map(plan => ({
          id: plan.id,
          name: plan.name,
          kind: plan.kind,
          journal_whitelist: plan.journal_whitelist === null ? null : JSON.parse(plan.journal_whitelist),
          orcid: plan.orcid,
          time_window_days: plan.time_window_days,
          search_interval_days: plan.search_interval_days,
          enabled: plan.enabled,
          notes: plan.notes,
        }))
        return { ok: true, plans }
      } catch (error) {
        return asError(error)
      }
    },
  }))
}

// ----------------------------------------------------------- plan remove

export function registerTrackingPlanRemoveTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: TRACKING_PLAN_REMOVE_TOOL_NAME,
    description: 'Delete one literature-tracking direction by id or name. Its search logs are removed with it; the global library is kept.',
    parameters: {
      plan: { type: 'string', required: true, description: 'Plan id or name.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true, const: true },
              deleted: { type: 'boolean', required: true },
            },
          },
          ERROR_SCHEMA,
        ],
      } as const,
      render: renderJsonValue,
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      try {
        return { ok: true, deleted: service.db.deleteTrackingPlan(args.plan) }
      } catch (error) {
        return asError(error)
      }
    },
  }))
}

// ---------------------------------------------------------------- search

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    unique_id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    url: { type: 'string', required: true },
    date: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    source: { type: 'string', required: true, enum: ['crossref', 'arxiv'] },
    journal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    authors: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

export function registerTrackingSearchTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: TRACKING_SEARCH_TOOL_NAME,
    description:
      'Run one literature-tracking direction\'s scheduled search: queries Crossref AND arXiv for the plan\'s '
      + 'configured window, applies the topic journal whitelist, stages every hit in the search cache, '
      + 'and auto-filters hits already in the global library (first-pass dedupe). Returns the candidates '
      + 'for MANUAL screening plus the new search-log id — finish the run with tracking_curate + tracking_log_complete.',
    parameters: {
      plan: { type: 'string', required: true, description: 'Plan id or name.' },
      limit: { type: 'integer', description: 'Maximum candidates to return, between 1 and 100. Defaults to 50.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true, const: true },
              plan_id: { type: 'string', required: true },
              plan_name: { type: 'string', required: true },
              window_start: { type: 'string', required: true },
              window_end: { type: 'string', required: true },
              log_id: { type: 'integer', required: true },
              candidates: { type: 'array', required: true, items: CANDIDATE_SCHEMA },
              excluded_already_curated: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    unique_id: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                  },
                },
              },
              warnings: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          ERROR_SCHEMA,
        ],
      } as const,
      render: renderJsonValue,
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const plan = service.db.getTrackingPlan(args.plan)
        if (plan === null) return { ok: false, code: 'plan_not_found', message: `No tracking plan '${args.plan}'.` }
        if (plan.enabled === 0) return { ok: false, code: 'plan_disabled', message: `Tracking plan '${plan.name}' is disabled.` }
        const outcome = await service.tracking.searchPlan(plan, exec.signal)
        const limit = Math.min(Math.max(args.limit ?? 50, 1), 100)
        return {
          ok: true,
          plan_id: outcome.plan_id,
          plan_name: outcome.plan_name,
          window_start: outcome.window_start,
          window_end: outcome.window_end,
          log_id: outcome.log_id,
          candidates: outcome.candidates.slice(0, limit),
          excluded_already_curated: outcome.excluded_already_curated,
          warnings: outcome.warnings,
        }
      } catch (error) {
        if (exec.signal.aborted) throw error
        return asError(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Tracking search', kind: 'search', rawInput: args.plan }),
  }))
}

// --------------------------------------------------------------- curate

const CURATED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    unique_id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    journal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    url: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    relevance: { type: 'string', required: true, enum: [...RELEVANCE_VALUES] },
    note: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    source_plan_id: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    added_at: { type: 'string', required: true },
  },
} as const

export function registerTrackingCurateTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: TRACKING_CURATE_TOOL_NAME,
    description:
      'Copy one screened paper from the search cache into the global curated library. The paper must already '
      + 'exist in the cache (tracking_search / literature_search remote hits write it there). Grade relevance: '
      + 'very_high / high / medium / low. The same unique_id (DOI or arxiv:xxxx.xxxxx) exists only once in the '
      + 'library — a repeat returns already_curated. Optional `plan` is stored as provenance only. Use `note` to '
      + 'record why (e.g. first/corresponding author, exact topic match).',
    parameters: {
      unique_id: {
        type: 'string',
        required: true,
        description: 'Canonical unique id from the search result: the DOI or arxiv:xxxx.xxxxx.',
      },
      relevance: {
        type: 'string',
        required: true,
        enum: [...RELEVANCE_VALUES],
        description: 'Screening grade: very_high (exact topic/method match), high (clearly relevant), medium (marginally relevant or the tracked person is NOT first/corresponding author), low (tangential).',
      },
      note: { type: 'string', description: 'Screening reason, e.g. author role or match justification.' },
      plan: { type: 'string', description: 'Optional plan id or name recorded as the source of this curation.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true, const: true },
              curated: { type: 'boolean', required: true },
              already_curated: { type: 'boolean', required: true },
              entry: { required: true, oneOf: [CURATED_SCHEMA, { type: 'null' }] },
            },
          },
          ERROR_SCHEMA,
        ],
      } as const,
      render: renderJsonValue,
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      try {
        let sourcePlanId: string | null = null
        if (args.plan !== undefined && String(args.plan).trim().length > 0) {
          const plan = service.db.getTrackingPlan(args.plan)
          if (plan === null) return { ok: false, code: 'plan_not_found', message: `No tracking plan '${args.plan}'.` }
          sourcePlanId = plan.id
        }
        const uniqueId = normalizeCandidateId(args.unique_id)
        if (uniqueId === null) return { ok: false, code: 'invalid_unique_id', message: `Unrecognized unique id '${args.unique_id}'.` }
        const existing = service.db.getLibraryPaper(uniqueId)
        if (existing !== null) {
          return {
            ok: true,
            curated: false,
            already_curated: true,
            entry: {
              unique_id: existing.unique_id,
              title: existing.title,
              journal: existing.journal,
              url: existing.url,
              relevance: existing.relevance,
              note: existing.note,
              source_plan_id: existing.source_plan_id,
              added_at: existing.added_at,
            },
          }
        }
        const paper = service.db.getPaper(uniqueId)
        if (paper === null) {
          return {
            ok: false,
            code: 'paper_not_in_legacy_db',
            message: `Paper '${uniqueId}' is not in the search cache yet; run tracking_search or literature_search first so its hits are cached.`,
          }
        }
        const created = service.db.curateFromCache(uniqueId, args.relevance as CurationRelevance, args.note ?? null, sourcePlanId)
        if (created === null) {
          const again = service.db.getLibraryPaper(uniqueId)
          return {
            ok: true,
            curated: false,
            already_curated: true,
            entry: again === null ? null : {
              unique_id: again.unique_id,
              title: again.title,
              journal: again.journal,
              url: again.url,
              relevance: again.relevance,
              note: again.note,
              source_plan_id: again.source_plan_id,
              added_at: again.added_at,
            },
          }
        }
        return {
          ok: true,
          curated: true,
          already_curated: false,
          entry: {
            unique_id: created.unique_id,
            title: created.title,
            journal: created.journal,
            url: created.url,
            relevance: created.relevance,
            note: created.note,
            source_plan_id: created.source_plan_id,
            added_at: created.added_at,
          },
        }
      } catch (error) {
        return asError(error)
      }
    },
  }))
}

// ---------------------------------------------------------- log complete

export function registerTrackingLogCompleteTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: TRACKING_LOG_COMPLETE_TOOL_NAME,
    description:
      'Complete one search log (搜索记录表) — the REQUIRED endpoint of every scheduled tracking run. Report each '
      + 'paper found relevant in this run with a one-sentence digest and its URL; the task is only finished once '
      + 'this tool returns ok with status done.',
    parameters: {
      log_id: { type: 'integer', required: true, description: 'Search-log id returned by tracking_search.' },
      findings: {
        type: 'array',
        required: true,
        description: 'Papers found relevant in this run, each with its unique id and a one-sentence digest.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            unique_id: { type: 'string', required: true },
            title: { type: 'string' },
            url: { type: 'string' },
            summary: { type: 'string', required: true },
          },
        },
      },
      summary: { type: 'string', description: 'Optional overall run summary.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true, const: true },
              status: { type: 'string', required: true, enum: ['done'] },
              log_id: { type: 'integer', required: true },
              findings_count: { type: 'integer', required: true },
            },
          },
          ERROR_SCHEMA,
        ],
      } as const,
      render: renderJsonValue,
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      try {
        const findings: SearchFinding[] = (args.findings ?? []).map((finding: {
          unique_id: string
          title?: string
          url?: string
          summary: string
        }) => ({
          unique_id: String(finding.unique_id),
          ...finding.title !== undefined ? { title: String(finding.title) } : {},
          ...finding.url !== undefined ? { url: String(finding.url) } : {},
          summary: String(finding.summary),
        }))
        const done = service.db.completeSearchLog(args.log_id, findings, args.summary ?? null)
        if (!done) return { ok: false, code: 'log_not_found_or_done', message: `Search log ${args.log_id} does not exist or is already done.` }
        return { ok: true, status: 'done' as const, log_id: args.log_id, findings_count: findings.length }
      } catch (error) {
        return asError(error)
      }
    },
  }))
}

// --------------------------------------------------------- curated list

export function registerTrackingCuratedListTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: TRACKING_CURATED_LIST_TOOL_NAME,
    description: 'List the global curated library with relevance grades and screening notes, newest first. Optional query searches the library FTS.',
    parameters: {
      query: { type: 'string', description: 'Optional full-text query over the global library.' },
      limit: { type: 'integer', description: 'Maximum entries, between 1 and 500. Defaults to 100.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true, const: true },
              entries: { type: 'array', required: true, items: CURATED_SCHEMA },
            },
          },
          ERROR_SCHEMA,
        ],
      } as const,
      render: renderJsonValue,
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      try {
        const entries = service.db.listLibraryPapers(args.limit ?? 100, args.query).map(entry => ({
          unique_id: entry.unique_id,
          title: entry.title,
          journal: entry.journal,
          url: entry.url,
          relevance: entry.relevance,
          note: entry.note,
          source_plan_id: entry.source_plan_id,
          added_at: entry.added_at,
        }))
        return { ok: true, entries }
      } catch (error) {
        return asError(error)
      }
    },
  }))
}

// -------------------------------------------------------------- log list

export function registerTrackingLogListTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: TRACKING_LOG_LIST_TOOL_NAME,
    description: 'List recent search logs (搜索记录表) with their status; pass a plan id/name to scope to one direction.',
    parameters: {
      plan: { type: 'string', description: 'Optional plan id or name.' },
      limit: { type: 'integer', description: 'Maximum logs, between 1 and 200. Defaults to 50.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true, const: true },
              logs: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'integer', required: true },
                    plan_id: { type: 'string', required: true },
                    started_at: { type: 'string', required: true },
                    window_start: { type: 'string', required: true },
                    window_end: { type: 'string', required: true },
                    status: { type: 'string', required: true, enum: ['running', 'done'] },
                    findings: {
                      required: true,
                      oneOf: [
                        {
                          type: 'array',
                          items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                              unique_id: { type: 'string', required: true },
                              title: { type: 'string' },
                              url: { type: 'string' },
                              summary: { type: 'string', required: true },
                            },
                          },
                        },
                        { type: 'null' },
                      ],
                    },
                    summary: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                    completed_at: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                  },
                },
              },
            },
          },
          ERROR_SCHEMA,
        ],
      } as const,
      render: renderJsonValue,
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      try {
        let planId: string | undefined
        if (args.plan !== undefined) {
          const plan = service.db.getTrackingPlan(args.plan)
          if (plan === null) return { ok: false, code: 'plan_not_found', message: `No tracking plan '${args.plan}'.` }
          planId = plan.id
        }
        const logs = service.db.listSearchLogs(planId, args.limit ?? 50).map(log => ({
          id: log.id,
          plan_id: log.plan_id,
          started_at: log.started_at,
          window_start: log.window_start,
          window_end: log.window_end,
          status: log.status,
          findings: log.findings === null ? null : JSON.parse(log.findings),
          summary: log.summary,
          completed_at: log.completed_at,
        }))
        return { ok: true, logs }
      } catch (error) {
        return asError(error)
      }
    },
  }))
}

/** Register every literature-tracking tool; returns one combined disposer. */
export function registerTrackingTools(ctx: Context, service: LiteratureService): () => void {
  const disposers = [
    registerTrackingPlanAddTool(ctx, service),
    registerTrackingPlanListTool(ctx, service),
    registerTrackingPlanRemoveTool(ctx, service),
    registerTrackingSearchTool(ctx, service),
    registerTrackingCurateTool(ctx, service),
    registerTrackingLogCompleteTool(ctx, service),
    registerTrackingCuratedListTool(ctx, service),
    registerTrackingLogListTool(ctx, service),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
