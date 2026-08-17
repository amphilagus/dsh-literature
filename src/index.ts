/**
 * dsh-literature: scientific-literature search for DeepSeek Harness agents.
 *
 * One function plugin providing (off by default; the 文献跟踪助理 preset
 * remounts it with `enabled: true`):
 * - `ctx.literature` — the literature service: a local SQLite database
 *   (`$DSH_HOME/data/literature/literature.db`) and a merged Crossref search
 *   engine, granted as an extra sandbox writable root;
 * - `literature_search` — merged local + Crossref keyword search;
 * - `literature_get` — DOI lookup, local cache first;
 * - `literature_db` — database management (stats, import, backup, ...);
 * - literature tracking — tracking-plan table, dual-source (Crossref + arXiv)
 *   windowed tracking_search with first-pass dedupe, curated direction
 *   libraries, search logs, researcher profiles, and the screening/scheduling
 *   runtime skills.
 * @module @amphilagus/dsh-literature
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { LiteratureService } from './literature-service.ts'
import type { LiteratureConfig } from './literature-service.ts'
import { SKILL_SURVEY, SKILL_SURVEY_CONTENT, SKILL_TRACKING_SEARCH, SKILL_TRACKING_SEARCH_CONTENT, SKILL_TRACKING_SETUP, SKILL_TRACKING_SETUP_CONTENT } from './skills.ts'
import { registerLiteratureDbTool } from './tools/db.ts'
import { registerLiteratureGetTool } from './tools/get.ts'
import { registerResearcherTools } from './tools/researcher.ts'
import { registerLiteratureSearchTool } from './tools/search.ts'
import { registerTrackingTools } from './tools/tracking.ts'

export { LiteratureService, defaultDbPath, DEFAULT_CROSSREF_BASE_URL, DEFAULT_ARXIV_BASE_URL, DEFAULT_ORCID_BASE_URL } from './literature-service.ts'
export type { LiteratureConfig } from './literature-service.ts'
export { bundledSciJournalsPath, installSciJournalsCatalog, SciJournalCatalog } from './db/catalog.ts'
export type { SciJournalHit, SciJournalSearchOptions } from './db/catalog.ts'
export type { DatabaseStats, ImportResult, JournalInput, JournalRecord, PaperFilters, PaperInput, PaperRecord } from './db/types.ts'
export type { CuratedPaperRecord, CuratedPaperView, CurationRelevance, SearchFinding, SearchLogRecord, TrackingPlanInput, TrackingPlanKind, TrackingPlanRecord, ResearcherProfileInput, ResearcherProfileRecord, ResearcherProfileStatus } from './db/types.ts'
export { CrossrefClient, CrossrefError, DEFAULT_CROSSREF_BASE_URL as CROSSREF_BASE_URL, normalizeDoi, stripJats, toPaperInput } from './engine/crossref.ts'
export type { CrossrefClientOptions, CrossrefSearchApi, CrossrefSearchPage, CrossrefWork, SearchWorksParams } from './engine/crossref.ts'
export { ArxivClient, ArxivError, DEFAULT_ARXIV_BASE_URL as ARXIV_BASE_URL, arxivAuthorQuery, arxivUniqueId, parseArxivEntry, toArxivPaperInput } from './engine/arxiv.ts'
export type { ArxivClientOptions, ArxivEntry, ArxivSearchApi, ArxivSearchParams } from './engine/arxiv.ts'
export { OrcidClient, OrcidError, DEFAULT_ORCID_BASE_URL as ORCID_BASE_URL, ORCID_PATTERN, normalizeOrcid, parseExpandedResults, profileIdFromOrcid } from './engine/orcid.ts'
export type { OrcidCandidate, OrcidClientOptions, OrcidExpandedSearchParams } from './engine/orcid.ts'
export { LiteratureSearchEngine, toHit, toHitFromWork } from './engine/engine.ts'
export type { LiteratureEngineOptions } from './engine/engine.ts'
export { TrackingSearchEngine, normalizeCandidateId } from './engine/tracking-engine.ts'
export type { DedupedHit, TrackingCandidate, TrackingEngineOptions, TrackingSearchOutcome } from './engine/tracking-engine.ts'
export type { GetErrorCode, GetFailure, GetResult, GetSuccess, PaperHit, PaperSource, SearchFailure, SearchOptions, SearchOutcome, SearchResult } from './engine/types.ts'
export { registerLiteratureDbTool, LITERATURE_DB_TOOL_NAME } from './tools/db.ts'
export { registerLiteratureGetTool, LITERATURE_GET_TOOL_NAME } from './tools/get.ts'
export { registerLiteratureSearchTool, LITERATURE_SEARCH_TOOL_NAME } from './tools/search.ts'
export { registerTrackingTools, TRACKING_CURATE_TOOL_NAME, TRACKING_CURATED_LIST_TOOL_NAME, TRACKING_LOG_COMPLETE_TOOL_NAME, TRACKING_LOG_LIST_TOOL_NAME, TRACKING_PLAN_ADD_TOOL_NAME, TRACKING_PLAN_LIST_TOOL_NAME, TRACKING_PLAN_REMOVE_TOOL_NAME, TRACKING_SEARCH_TOOL_NAME } from './tools/tracking.ts'
export { registerResearcherTools, RESEARCHER_PROFILE_DISAMBIGUATE_TOOL_NAME, RESEARCHER_PROFILE_QUERY_TOOL_NAME, RESEARCHER_PROFILE_REMOVE_TOOL_NAME, RESEARCHER_PROFILE_UPSERT_TOOL_NAME } from './tools/researcher.ts'
export { SKILL_SURVEY, SKILL_TRACKING_SEARCH, SKILL_TRACKING_SETUP } from './skills.ts'

/** Cordis function-plugin name. */
export const name = 'literature-search'

/** Services required before the literature plugin can load. */
export const inject = ['tools', 'systemPrompt', 'skills']

/** Plugin configuration; see {@link LiteratureConfig}. */
export interface Config extends LiteratureConfig {}

/** Duck-typed extra-root grant so unpatched `sandboxPolicy` is not a load error. */
interface SandboxPolicyGrant {
  grant?: (spec: { name: string; roots: () => readonly string[] }) => unknown
}

/**
 * Register `$DSH_HOME/data/literature` as a sandbox extra write root when
 * this DSH build has `sandboxPolicy.grant`. Missing service, or a service
 * without `grant`, is skipped — literature tools do not go through sandbox.
 */
function tryGrantLiteratureDataRoot(ctx: Context, dataDir: string): void {
  const policy = ctx.get('sandboxPolicy') as SandboxPolicyGrant | undefined
  if (policy === undefined) return
  if (typeof policy.grant !== 'function') {
    ctx.logger?.(name).info('dsh-literature: sandboxPolicy.grant unavailable — extra write root skipped')
    return
  }
  policy.grant({
    name: 'literature-data',
    roots: () => [dataDir],
  })
}

const TOOL_GUIDANCE =
  'Use literature_search (query; optional orcid and recentDays), literature_get (DOI), and literature_db '
  + '(stats/import/backup and SCI journals by title/ISSN/CAS). Prefer a local search for papers already stored; '
  + 'remote Crossref is rate-limited. Use recentDays for last-N-day windows, not fromYear. '
  + 'Tracking: tracking_plan_add/list/remove, tracking_search, tracking_curate, tracking_log_complete, '
  + 'tracking_curated_list, tracking_log_list. '
  + 'Researcher identity: researcher_profile_disambiguate, researcher_profile_upsert, '
  + 'researcher_profile_query, researcher_profile_remove (档案跨会话存活; 建 person 方向前先消歧并建档). '
  + 'Load literature-survey for a one-off topic or author survey, literature-tracking-setup before configuring a direction, '
  + 'and literature-tracking-search before a scheduled tracking run.'

/**
 * Mount the literature service, optional sandbox extra-root grant, tools,
 * and tracking runtime skills.
 * @param ctx - the host context.
 * @param config - optional database path and Crossref options.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled !== true) {
    // Master switch, off by default: register no tools and provide no
    // literature service. A session preset that remounts this plugin with
    // `enabled: true` exposes the toolset to exactly those agents.
    ctx.logger?.(name).info('dsh-literature disabled by config (enabled: false) — inert entry')
    return
  }

  // The Service constructor registers itself under ctx.literature; applying
  // it as part of this plugin's fiber keeps the disposal chain correct.
  const service = new LiteratureService(ctx, config)

  // Optional: extra sandbox write root for bash/fs. Unpatched DSH builds
  // have sandboxPolicy without grant(); literature tools still load.
  tryGrantLiteratureDataRoot(ctx, service.db.dataDir)

  registerLiteratureSearchTool(ctx, service)
  registerLiteratureGetTool(ctx, service)
  registerLiteratureDbTool(ctx, service)
  registerTrackingTools(ctx, service)
  registerResearcherTools(ctx, service)

  // Runtime skills: the workflows the tools deliberately leave to the agent.
  ctx.skills.register({
    name: SKILL_TRACKING_SETUP,
    description: 'Configure literature-tracking directions (topic with journal whitelist / researcher with ORCID) and their schedule reminders.',
    source: 'runtime',
    content: SKILL_TRACKING_SETUP_CONTENT,
  })
  ctx.skills.register({
    name: SKILL_TRACKING_SEARCH,
    description: 'Run a scheduled literature-tracking search: dual-source search, manual relevance screening, curation, and closing the search log.',
    source: 'runtime',
    content: SKILL_TRACKING_SEARCH_CONTENT,
  })
  ctx.skills.register({
    name: SKILL_SURVEY,
    description: 'One-off literature survey of a topic or author via literature_search (optional recentDays / orcid). Not a tracking plan.',
    source: 'runtime',
    content: SKILL_SURVEY_CONTENT,
  })

  ctx.systemPrompt.section({
    name: 'tool:literature',
    order: 104,
    text: TOOL_GUIDANCE,
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    literature: LiteratureService
  }
}
