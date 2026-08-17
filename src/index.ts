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
 *   libraries, search logs, and the screening/scheduling runtime skills.
 * @module @amphilagus/dsh-literature
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { LiteratureService } from './literature-service.ts'
import type { LiteratureConfig } from './literature-service.ts'
import { SKILL_TRACKING_SEARCH, SKILL_TRACKING_SEARCH_CONTENT, SKILL_TRACKING_SETUP, SKILL_TRACKING_SETUP_CONTENT } from './skills.ts'
import { registerLiteratureDbTool } from './tools/db.ts'
import { registerLiteratureGetTool } from './tools/get.ts'
import { registerLiteratureSearchTool } from './tools/search.ts'
import { registerTrackingTools } from './tools/tracking.ts'

export { LiteratureService, defaultDbPath, DEFAULT_CROSSREF_BASE_URL, DEFAULT_ARXIV_BASE_URL } from './literature-service.ts'
export type { LiteratureConfig } from './literature-service.ts'
export { LiteratureDatabase, toFtsQuery, escapeLike } from './db/database.ts'
export type { DatabaseStats, ImportResult, JournalInput, JournalRecord, PaperFilters, PaperInput, PaperRecord } from './db/types.ts'
export type { CuratedPaperRecord, CuratedPaperView, CurationRelevance, SearchFinding, SearchLogRecord, TrackingPlanInput, TrackingPlanKind, TrackingPlanRecord } from './db/types.ts'
export { CrossrefClient, CrossrefError, DEFAULT_CROSSREF_BASE_URL as CROSSREF_BASE_URL, normalizeDoi, stripJats, toPaperInput } from './engine/crossref.ts'
export type { CrossrefClientOptions, CrossrefSearchApi, CrossrefSearchPage, CrossrefWork, SearchWorksParams } from './engine/crossref.ts'
export { ArxivClient, ArxivError, DEFAULT_ARXIV_BASE_URL as ARXIV_BASE_URL, arxivAuthorQuery, arxivUniqueId, parseArxivEntry, toArxivPaperInput } from './engine/arxiv.ts'
export type { ArxivClientOptions, ArxivEntry, ArxivSearchApi, ArxivSearchParams } from './engine/arxiv.ts'
export { LiteratureSearchEngine, toHit, toHitFromWork } from './engine/engine.ts'
export type { LiteratureEngineOptions } from './engine/engine.ts'
export { TrackingSearchEngine, normalizeCandidateId } from './engine/tracking-engine.ts'
export type { DedupedHit, TrackingCandidate, TrackingEngineOptions, TrackingSearchOutcome } from './engine/tracking-engine.ts'
export type { GetErrorCode, GetFailure, GetResult, GetSuccess, PaperHit, PaperSource, SearchFailure, SearchOptions, SearchOutcome, SearchResult } from './engine/types.ts'
export { registerLiteratureDbTool, LITERATURE_DB_TOOL_NAME } from './tools/db.ts'
export { registerLiteratureGetTool, LITERATURE_GET_TOOL_NAME } from './tools/get.ts'
export { registerLiteratureSearchTool, LITERATURE_SEARCH_TOOL_NAME } from './tools/search.ts'
export { registerTrackingTools, TRACKING_CURATE_TOOL_NAME, TRACKING_CURATED_LIST_TOOL_NAME, TRACKING_LOG_COMPLETE_TOOL_NAME, TRACKING_LOG_LIST_TOOL_NAME, TRACKING_PLAN_ADD_TOOL_NAME, TRACKING_PLAN_LIST_TOOL_NAME, TRACKING_PLAN_REMOVE_TOOL_NAME, TRACKING_SEARCH_TOOL_NAME } from './tools/tracking.ts'
export { SKILL_TRACKING_SEARCH, SKILL_TRACKING_SETUP } from './skills.ts'

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
  'Use literature_search to find scientific papers on a research topic (it merges the local literature '
  + 'database with Crossref), literature_get to fetch one paper\'s full details by DOI, and literature_db '
  + 'to inspect or manage the local literature database (stats, import, backup, export). Prefer a local '
  + 'literature_db search for papers already stored, and remember that remote Crossref calls are '
  + 'rate-limited and polite-pool shared. '
  + 'For the literature-tracking workflow use tracking_plan_add/list/remove (跟踪方案表), tracking_search '
  + '(Crossref + arXiv windowed search with first-pass dedupe), tracking_curate (curate into a direction '
  + 'library), tracking_log_complete (fill the search log — the run\'s completion endpoint), and '
  + 'tracking_curated_list/tracking_log_list to inspect. Load the literature-tracking-setup or '
  + 'literature-tracking-search skill before configuring directions or running a scheduled search.'

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
