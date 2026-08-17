/**
 * Shared rendering helpers for the literature tools: canonical JSON output,
 * readable digests for native mode, and pending/completed UI cards.
 * @module @amphilagus/dsh-literature/tools/render
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { GenericCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { PaperHit } from '../engine/types.ts'

/** Raw JSON projection: the whole structured outcome for the model. */
export function renderJsonValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Trim an abstract for a digest without breaking token budget. */
export function excerpt(text: string | null | undefined, max = 420): string {
  if (text === null || text === undefined) return 'no abstract'
  const single = text.replace(/\s+/g, ' ').trim()
  if (single.length <= max) return single
  return `${single.slice(0, max).trimEnd()}…`
}

function authorList(hit: PaperHit): string {
  if (hit.authors.length === 0) return 'unknown authors'
  if (hit.authors.length <= 5) return hit.authors.join(', ')
  return `${hit.authors.slice(0, 5).join(', ')}, et al. (${hit.authors.length} authors)`
}

/** One paper as a compact readable paragraph for native mode. */
export function digestPaper(hit: PaperHit, index: number): string {
  const year = hit.year === null ? 'n.d.' : String(hit.year)
  const meta = [
    hit.journal,
    hit.openAccess ? 'open access' : null,
    hit.citations > 0 ? `cited ${hit.citations}×` : null,
    hit.source,
  ].filter((entry): entry is string => entry !== null)
  return [
    `${index}. ${hit.title} — ${authorList(hit)} (${year})`,
    `   ${meta.join(' · ')}`,
    `   DOI: ${hit.doi}${hit.url !== null && hit.url !== `https://doi.org/${hit.doi}` ? `\n   URL: ${hit.url}` : ''}`,
    `   ${excerpt(hit.abstract)}`,
  ].join('\n')
}

/** Pending-state card for a search call. */
export function presentSearchCall(query: string): GenericCallView {
  return { card: 'generic', title: 'Literature search', kind: 'search', rawInput: query }
}

/** Completed-state card: the readable digest list. */
export function presentDigestResult(title: string, lines: string[]): ToolResultView {
  return { card: 'generic', title, content: [{ type: 'text', text: lines.join('\n\n') }] }
}
