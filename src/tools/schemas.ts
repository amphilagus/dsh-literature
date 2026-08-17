/**
 * Shared JSON-schema fragments for the literature tool outputs.
 * @module @amphilagus/dsh-literature/tools/schemas
 */

/** The canonical one-paper shape shared by every tool output. */
export const PAPER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doi: { type: 'string', required: true },
    title: { type: 'string', required: true },
    authors: { type: 'array', required: true, items: { type: 'string' } },
    journal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    year: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
    publicationDate: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    abstract: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    url: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    openAccess: { type: 'boolean', required: true },
    citations: { type: 'integer', required: true },
    source: { type: 'string', required: true, enum: ['local', 'crossref'] },
  },
} as const

/** The canonical tool-level failure shape. */
export const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: false },
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const
