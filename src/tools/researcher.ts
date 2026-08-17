/**
 * Researcher-profile tools: persist identity, research areas, and
 * disambiguation notes across sessions, and look up ORCID name collisions.
 * @module @amphilagus/dsh-literature/tools/researcher
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ResearcherProfileRecord, ResearcherProfileStatus } from '../db/types.ts'
import { normalizeOrcid, OrcidError, profileIdFromOrcid } from '../engine/orcid.ts'
import type { LiteratureService } from '../literature-service.ts'
import { renderJsonValue } from './render.ts'
import { ERROR_SCHEMA } from './schemas.ts'

export const RESEARCHER_PROFILE_UPSERT_TOOL_NAME = 'researcher_profile_upsert'
export const RESEARCHER_PROFILE_QUERY_TOOL_NAME = 'researcher_profile_query'
export const RESEARCHER_PROFILE_DISAMBIGUATE_TOOL_NAME = 'researcher_profile_disambiguate'
export const RESEARCHER_PROFILE_REMOVE_TOOL_NAME = 'researcher_profile_remove'

const STATUS_VALUES = ['active', 'archived'] as const

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asError(error: unknown): { ok: false; code: string; message: string } {
  return { ok: false, code: 'internal_error', message: messageOf(error) }
}

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    display_name: { type: 'string', required: true },
    family_name: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    given_name: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    name_zh: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    orcid: { type: 'string', required: true },
    institution: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    homepage: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    email: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    research_areas: {
      required: true,
      oneOf: [
        { type: 'array', items: { type: 'json' } },
        { type: 'null' },
      ],
    },
    aliases: {
      required: true,
      oneOf: [
        { type: 'array', items: { type: 'string' } },
        { type: 'null' },
      ],
    },
    disambiguation_notes: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    plan_id: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    notes: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    status: { type: 'string', required: true, enum: ['active', 'archived'] },
    created_at: { type: 'string', required: true },
    updated_at: { type: 'string', required: true },
  },
} as const

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    orcid: { type: 'string', required: true },
    given_names: { type: 'string', required: true },
    family_names: { type: 'string', required: true },
    institution_names: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

function presentProfile(record: ResearcherProfileRecord) {
  return {
    id: record.id,
    display_name: record.display_name,
    family_name: record.family_name,
    given_name: record.given_name,
    name_zh: record.name_zh,
    orcid: record.orcid,
    institution: record.institution,
    homepage: record.homepage,
    email: record.email,
    research_areas: record.research_areas === null || record.research_areas.length === 0
      ? null
      : JSON.parse(record.research_areas),
    aliases: record.aliases === null || record.aliases.length === 0
      ? null
      : JSON.parse(record.aliases),
    disambiguation_notes: record.disambiguation_notes,
    plan_id: record.plan_id,
    notes: record.notes,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
  }
}

function encodeResearchAreas(value: unknown): { ok: true; json: string } | { ok: false; message: string } {
  if (!Array.isArray(value)) {
    return { ok: false, message: 'research_areas must be an array of {area, confidence, evidence}.' }
  }
  const areas: { area: string; confidence?: number; evidence?: string }[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') {
      return { ok: false, message: 'each research_areas entry must be an object.' }
    }
    const row = item as Record<string, unknown>
    if (typeof row.area !== 'string' || row.area.trim().length === 0) {
      return { ok: false, message: 'each research_areas entry needs a non-empty area string.' }
    }
    const encoded: { area: string; confidence?: number; evidence?: string } = { area: row.area.trim() }
    if (row.confidence !== undefined) {
      if (typeof row.confidence !== 'number' || row.confidence < 0 || row.confidence > 1) {
        return { ok: false, message: 'research_areas.confidence must be a number between 0 and 1.' }
      }
      encoded.confidence = row.confidence
    }
    if (row.evidence !== undefined) {
      if (typeof row.evidence !== 'string') {
        return { ok: false, message: 'research_areas.evidence must be a string.' }
      }
      encoded.evidence = row.evidence
    }
    areas.push(encoded)
  }
  return { ok: true, json: JSON.stringify(areas) }
}

function encodeAliases(value: unknown): { ok: true; json: string } | { ok: false; message: string } {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    return { ok: false, message: 'aliases must be an array of strings.' }
  }
  return { ok: true, json: JSON.stringify(value) }
}

function parseStatus(value: unknown): ResearcherProfileStatus | null {
  if (value === undefined) return 'active'
  if (typeof value === 'string' && (STATUS_VALUES as readonly string[]).includes(value)) {
    return value as ResearcherProfileStatus
  }
  return null
}

type ResolveResult =
  | { ok: true; records: ResearcherProfileRecord[] }
  | { ok: false; code: string; message: string }

function resolveProfiles(service: LiteratureService, key: string): ResolveResult {
  const records = service.db.findResearcherProfiles(key.trim())
  if (records.length === 0) {
    return { ok: false, code: 'not_found', message: `No researcher profile '${key}'.` }
  }
  return { ok: true, records }
}

// -------------------------------------------------------------- upsert

export function registerResearcherProfileUpsertTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: RESEARCHER_PROFILE_UPSERT_TOOL_NAME,
    description:
      'Create or update one persistent researcher profile (科研人员档案). Requires a verified ORCID. '
      + 'Stores display name, Chinese name, institution, research_areas, aliases, and disambiguation_notes '
      + 'across sessions. Same ORCID updates in place. Optional plan_id links a person tracking plan; '
      + 'unknown plan_id is ignored with a warning.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Display name, e.g. "Jinglai Duan" or "段敬来 (Jinglai Duan)".',
      },
      orcid: {
        type: 'string',
        required: true,
        description: 'ORCID, format 0000-0000-0000-0000. The profile id is derived from this value.',
      },
      family_name: { type: 'string', description: 'Family name / surname, e.g. Duan.' },
      given_name: { type: 'string', description: 'Given name, e.g. Jinglai.' },
      name_zh: { type: 'string', description: 'Chinese name, stored as-is.' },
      institution: { type: 'string', description: 'Current affiliation.' },
      homepage: { type: 'string', description: 'Homepage URL.' },
      email: { type: 'string', description: 'Contact email.' },
      research_areas: {
        type: 'json',
        description: 'Agent-curated directions as [{area, confidence (0-1), evidence}]. Tools do not infer these.',
      },
      aliases: {
        type: 'array',
        items: { type: 'string' },
        description: 'Name variants, e.g. ["段敬来", "J. Duan"].',
      },
      disambiguation_notes: {
        type: 'string',
        description: 'Evidence that this ORCID is the intended person (affiliation confirmed, etc.).',
      },
      plan_id: {
        type: 'string',
        description: 'Optional tracking-plan id or name to associate. Ignored with a warning if missing.',
      },
      notes: { type: 'string', description: 'Free-form notes.' },
      status: {
        type: 'string',
        enum: ['active', 'archived'],
        description: 'active (default) or archived.',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true, const: true },
              profile: PROFILE_SCHEMA,
              warning: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
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
        const name = args.name.trim()
        if (name.length === 0) {
          return { ok: false, code: 'invalid_name', message: 'name must be a non-empty display name.' }
        }
        const orcid = normalizeOrcid(String(args.orcid ?? ''))
        if (orcid === null) {
          return { ok: false, code: 'invalid_orcid', message: 'orcid must match 0000-0000-0000-0000.' }
        }
        let warning: string | null = null
        let planId: string | null | undefined
        if (args.plan_id !== undefined) {
          const plan = service.db.getTrackingPlan(args.plan_id.trim())
          if (plan === null) {
            warning = `No tracking plan '${args.plan_id}'; profile saved without plan_id.`
          } else {
            planId = plan.id
          }
        }
        let researchAreasJson: string | undefined
        if (args.research_areas !== undefined) {
          const encoded = encodeResearchAreas(args.research_areas)
          if (!encoded.ok) return { ok: false, code: 'invalid_research_areas', message: encoded.message }
          researchAreasJson = encoded.json
        }
        let aliasesJson: string | undefined
        if (args.aliases !== undefined) {
          const encoded = encodeAliases(args.aliases)
          if (!encoded.ok) return { ok: false, code: 'invalid_aliases', message: encoded.message }
          aliasesJson = encoded.json
        }
        const status = parseStatus(args.status)
        if (status === null) {
          return { ok: false, code: 'invalid_status', message: 'status must be active or archived.' }
        }
        const id = profileIdFromOrcid(orcid)
        service.db.upsertResearcherProfile({
          id,
          display_name: name,
          orcid,
          ...args.family_name !== undefined ? { family_name: args.family_name } : {},
          ...args.given_name !== undefined ? { given_name: args.given_name } : {},
          ...args.name_zh !== undefined ? { name_zh: args.name_zh } : {},
          ...args.institution !== undefined ? { institution: args.institution } : {},
          ...args.homepage !== undefined ? { homepage: args.homepage } : {},
          ...args.email !== undefined ? { email: args.email } : {},
          ...researchAreasJson !== undefined ? { research_areas: researchAreasJson } : {},
          ...aliasesJson !== undefined ? { aliases: aliasesJson } : {},
          ...args.disambiguation_notes !== undefined ? { disambiguation_notes: args.disambiguation_notes } : {},
          ...planId !== undefined ? { plan_id: planId } : {},
          ...args.notes !== undefined ? { notes: args.notes } : {},
          ...args.status !== undefined ? { status } : {},
        })
        const record = service.db.getResearcherProfileById(id)
        if (record === null) return { ok: false, code: 'not_found', message: 'Profile vanished after upsert.' }
        return { ok: true, profile: presentProfile(record), warning }
      } catch (error) {
        return asError(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Upsert researcher profile', kind: 'edit', rawInput: args.name }),
  }))
}

// --------------------------------------------------------------- query

export function registerResearcherProfileQueryTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: RESEARCHER_PROFILE_QUERY_TOOL_NAME,
    description:
      'Look up researcher profiles. Pass `profile` (id, ORCID, or exact display/Chinese name) for one or '
      + 'a few matches; pass `query` for a substring search over name, institution, research_areas, and aliases '
      + '(JSON LIKE — useful but not precise); pass neither to list. Default status=active. Does not return works.',
    parameters: {
      profile: {
        type: 'string',
        description: 'Profile id, ORCID, or exact display_name / name_zh. Takes precedence over query.',
      },
      query: {
        type: 'string',
        description: 'Keyword matched with SQL LIKE across name, institution, research_areas, and aliases.',
      },
      status: {
        type: 'string',
        enum: ['active', 'archived'],
        description: 'Filter for list/search. Defaults to active. Ignored for exact profile lookup.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum rows for list/search, between 1 and 200. Defaults to 50.',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true, const: true },
              ambiguous: { type: 'boolean', required: true },
              profiles: { type: 'array', required: true, items: PROFILE_SCHEMA },
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
        const status = parseStatus(args.status)
        if (args.status !== undefined && status === null) {
          return { ok: false, code: 'invalid_status', message: 'status must be active or archived.' }
        }
        const listStatus = status ?? 'active'
        const limit = args.limit ?? 50
        const profileKey = args.profile?.trim()
        if (profileKey !== undefined && profileKey.length > 0) {
          const resolved = resolveProfiles(service, profileKey)
          if (!resolved.ok) return resolved
          return {
            ok: true,
            ambiguous: resolved.records.length > 1,
            profiles: resolved.records.map(presentProfile),
          }
        }
        const query = args.query?.trim()
        const records = query !== undefined && query.length > 0
          ? service.db.searchResearcherProfiles(query, listStatus, limit)
          : service.db.listResearcherProfiles(listStatus, limit)
        return { ok: true, ambiguous: false, profiles: records.map(presentProfile) }
      } catch (error) {
        return asError(error)
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Query researcher profiles',
      kind: 'read',
      rawInput: args.profile ?? args.query ?? 'list',
    }),
  }))
}

// -------------------------------------------------------- disambiguate

export function registerResearcherProfileDisambiguateTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: RESEARCHER_PROFILE_DISAMBIGUATE_TOOL_NAME,
    description:
      'Search the ORCID public expanded-search index for same-name candidates before creating a profile '
      + 'or a person tracking plan. Confirm the chosen ORCID with the user, then store it via '
      + 'researcher_profile_upsert together with disambiguation_notes.',
    parameters: {
      family_name: { type: 'string', required: true, description: 'Family name / surname, e.g. Duan.' },
      given_name: { type: 'string', required: true, description: 'Given name, e.g. Jinglai.' },
      affiliation: { type: 'string', description: 'Optional organization name to narrow the search.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true, const: true },
              candidates: { type: 'array', required: true, items: CANDIDATE_SCHEMA },
            },
          },
          ERROR_SCHEMA,
        ],
      } as const,
      render: renderJsonValue,
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const familyName = args.family_name.trim()
        const givenName = args.given_name.trim()
        if (familyName.length === 0 || givenName.length === 0) {
          return { ok: false, code: 'invalid_name', message: 'family_name and given_name must be non-empty.' }
        }
        const candidates = await service.orcid.expandedSearch({
          familyName,
          givenName,
          ...args.affiliation !== undefined ? { affiliation: args.affiliation } : {},
        }, exec.signal)
        return { ok: true, candidates }
      } catch (error) {
        if (error instanceof OrcidError) {
          return { ok: false, code: 'orcid_search_failed', message: error.message }
        }
        return asError(error)
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Disambiguate researcher',
      kind: 'read',
      rawInput: `${args.family_name}, ${args.given_name}`,
    }),
  }))
}

// --------------------------------------------------------------- remove

export function registerResearcherProfileRemoveTool(ctx: Context, service: LiteratureService): () => void {
  return ctx.tools.register(defineTool({
    name: RESEARCHER_PROFILE_REMOVE_TOOL_NAME,
    description:
      'Delete one researcher profile by id, ORCID, or exact name. Does not delete the linked tracking plan. '
      + 'If several profiles share the same display/Chinese name, returns ambiguous and deletes nothing.',
    parameters: {
      profile: { type: 'string', required: true, description: 'Profile id, ORCID, or exact display_name / name_zh.' },
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
        const key = args.profile.trim()
        const records = service.db.findResearcherProfiles(key)
        if (records.length === 0) return { ok: true, deleted: false }
        if (records.length > 1) {
          return { ok: false, code: 'ambiguous', message: `Multiple researcher profiles match '${key}'.` }
        }
        const record = records[0]
        if (record === undefined) return { ok: true, deleted: false }
        return { ok: true, deleted: service.db.deleteResearcherProfile(record.id) }
      } catch (error) {
        return asError(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Remove researcher profile', kind: 'edit', rawInput: args.profile }),
  }))
}

/** Register every researcher-profile tool; returns one combined disposer. */
export function registerResearcherTools(ctx: Context, service: LiteratureService): () => void {
  const disposers = [
    registerResearcherProfileUpsertTool(ctx, service),
    registerResearcherProfileQueryTool(ctx, service),
    registerResearcherProfileDisambiguateTool(ctx, service),
    registerResearcherProfileRemoveTool(ctx, service),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
