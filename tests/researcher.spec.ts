/**
 * Researcher-profile tool tests: upsert/query/remove through the registry,
 * plan_id warnings, name ambiguity, and mocked ORCID disambiguation.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as literature from '../src/index.ts'

const originalFetch = globalThis.fetch
const fetchMock = vi.fn<typeof fetch>()

function fakeExec(overrides: Record<string, unknown> = {}): ToolRunContext {
  return {
    callId: 'test-call',
    rootCallId: 'test-call',
    name: 'researcher_profile_upsert',
    arguments: {},
    token: Symbol('test-token'),
    signal: new AbortController().signal,
    deferContext: () => {},
    concludeTurn: () => {},
    ...overrides,
  } as unknown as ToolRunContext
}

const cleanups: (() => void)[] = []
const tmpDb = (): { dir: string; dbPath: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-literature-researcher-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, dbPath: join(dir, 'literature.db') }
}

async function harness(dbPath: string): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SkillRegistry, {})
  await ctx.plugin(literature, { enabled: true, dbPath })
  return ctx
}

afterEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = originalFetch
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe('researcher profile tools', () => {
  it('upserts, queries by id/orcid/name, and keeps unsupplied fields', async () => {
    const { dbPath } = tmpDb()
    const ctx = await harness(dbPath)
    const upsert = ctx.tools.get('researcher_profile_upsert') as ToolDefinition
    const query = ctx.tools.get('researcher_profile_query') as ToolDefinition

    const created = await upsert.execute({
      name: '段敬来 (Jinglai Duan)',
      orcid: '0000-0002-9019-5088',
      name_zh: '段敬来',
      family_name: 'Duan',
      given_name: 'Jinglai',
      disambiguation_notes: 'IMP confirmed with user',
      research_areas: [{ area: 'ion track', confidence: 0.9, evidence: 'ORCID titles' }],
      aliases: ['J. Duan'],
    }, fakeExec()) as { ok: boolean; profile: { id: string; notes: string | null }; warning: string | null }
    expect(created).toMatchObject({
      ok: true,
      warning: null,
      profile: { id: 'profile-0000-0002-9019-5088', orcid: '0000-0002-9019-5088' },
    })

    const updated = await upsert.execute({
      name: '段敬来 (Jinglai Duan)',
      orcid: '0000-0002-9019-5088',
      institution: 'Institute of Modern Physics, CAS',
    }, fakeExec()) as { ok: boolean; profile: { institution: string | null; disambiguation_notes: string | null; research_areas: unknown } }
    expect(updated.profile.institution).toBe('Institute of Modern Physics, CAS')
    expect(updated.profile.disambiguation_notes).toBe('IMP confirmed with user')
    expect(updated.profile.research_areas).toEqual([{ area: 'ion track', confidence: 0.9, evidence: 'ORCID titles' }])

    const byOrcid = await query.execute(
      { profile: '0000-0002-9019-5088' },
      fakeExec({ name: 'researcher_profile_query' }),
    ) as { ok: boolean; ambiguous: boolean; profiles: { id: string }[] }
    expect(byOrcid).toMatchObject({ ok: true, ambiguous: false })
    expect(byOrcid.profiles).toHaveLength(1)

    const byName = await query.execute(
      { profile: '段敬来' },
      fakeExec({ name: 'researcher_profile_query' }),
    ) as { profiles: { name_zh: string | null }[] }
    expect(byName.profiles[0]?.name_zh).toBe('段敬来')

    const searched = await query.execute(
      { query: 'ion track' },
      fakeExec({ name: 'researcher_profile_query' }),
    ) as { profiles: { id: string }[] }
    expect(searched.profiles.map(row => row.id)).toEqual(['profile-0000-0002-9019-5088'])

    await ctx.fiber.dispose()
  })

  it('warns on a missing plan_id without failing the upsert', async () => {
    const { dbPath } = tmpDb()
    const ctx = await harness(dbPath)
    const upsert = ctx.tools.get('researcher_profile_upsert') as ToolDefinition
    const result = await upsert.execute({
      name: 'Jinglai Duan',
      orcid: '0000-0002-9019-5088',
      plan_id: 'plan-does-not-exist',
    }, fakeExec()) as { ok: boolean; warning: string | null; profile: { plan_id: string | null } }
    expect(result.ok).toBe(true)
    expect(result.profile.plan_id).toBeNull()
    expect(result.warning).toMatch(/plan-does-not-exist/)
    await ctx.fiber.dispose()
  })

  it('rejects a malformed ORCID', async () => {
    const { dbPath } = tmpDb()
    const ctx = await harness(dbPath)
    const upsert = ctx.tools.get('researcher_profile_upsert') as ToolDefinition
    const result = await upsert.execute({
      name: 'Jinglai Duan',
      orcid: 'not-an-orcid',
    }, fakeExec()) as { ok: boolean; code: string }
    expect(result).toMatchObject({ ok: false, code: 'invalid_orcid' })
    await ctx.fiber.dispose()
  })

  it('marks exact name collisions as ambiguous and refuses to delete them', async () => {
    const { dbPath } = tmpDb()
    const ctx = await harness(dbPath)
    const upsert = ctx.tools.get('researcher_profile_upsert') as ToolDefinition
    const query = ctx.tools.get('researcher_profile_query') as ToolDefinition
    const remove = ctx.tools.get('researcher_profile_remove') as ToolDefinition
    await upsert.execute({ name: 'Li Wei', orcid: '0000-0002-0000-0001', name_zh: '李伟' }, fakeExec())
    await upsert.execute({ name: 'Li Wei', orcid: '0000-0002-0000-0002', name_zh: '李伟' }, fakeExec())

    const listed = await query.execute(
      { profile: 'Li Wei' },
      fakeExec({ name: 'researcher_profile_query' }),
    ) as { ok: boolean; ambiguous: boolean; profiles: unknown[] }
    expect(listed).toMatchObject({ ok: true, ambiguous: true })
    expect(listed.profiles).toHaveLength(2)

    const blocked = await remove.execute(
      { profile: 'Li Wei' },
      fakeExec({ name: 'researcher_profile_remove' }),
    ) as { ok: boolean; code: string }
    expect(blocked).toMatchObject({ ok: false, code: 'ambiguous' })

    const deleted = await remove.execute(
      { profile: '0000-0002-0000-0001' },
      fakeExec({ name: 'researcher_profile_remove' }),
    ) as { ok: boolean; deleted: boolean }
    expect(deleted).toEqual({ ok: true, deleted: true })
    await ctx.fiber.dispose()
  })

  it('links an existing profile when tracking_plan_add creates the person plan', async () => {
    const { dbPath } = tmpDb()
    const ctx = await harness(dbPath)
    const upsert = ctx.tools.get('researcher_profile_upsert') as ToolDefinition
    const addPlan = ctx.tools.get('tracking_plan_add') as ToolDefinition
    const query = ctx.tools.get('researcher_profile_query') as ToolDefinition
    await upsert.execute({
      name: 'Jinglai Duan',
      orcid: '0000-0002-9019-5088',
    }, fakeExec())
    await addPlan.execute({
      name: 'Jinglai Duan',
      kind: 'person',
      orcid: '0000-0002-9019-5088',
    }, fakeExec({ name: 'tracking_plan_add' }))
    const found = await query.execute(
      { profile: '0000-0002-9019-5088' },
      fakeExec({ name: 'researcher_profile_query' }),
    ) as { profiles: { plan_id: string | null }[] }
    expect(found.profiles[0]?.plan_id).toBe('plan-jinglai-duan')
    await ctx.fiber.dispose()
  })

  it('disambiguates through the mocked ORCID client', async () => {
    globalThis.fetch = fetchMock
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      'expanded-result': [{
        'orcid-id': '0000-0002-9019-5088',
        'given-names': 'Jinglai',
        'family-names': 'Duan',
        'institution-name': ['Institute of Modern Physics'],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { dbPath } = tmpDb()
    const ctx = await harness(dbPath)
    const tool = ctx.tools.get('researcher_profile_disambiguate') as ToolDefinition
    const result = await tool.execute({
      family_name: 'Duan',
      given_name: 'Jinglai',
      affiliation: 'Institute of Modern Physics',
    }, fakeExec({ name: 'researcher_profile_disambiguate' })) as {
      ok: boolean
      candidates: { orcid: string }[]
    }
    expect(result.ok).toBe(true)
    expect(result.candidates).toEqual([expect.objectContaining({ orcid: '0000-0002-9019-5088' })])
    await ctx.fiber.dispose()
  })

  it('maps ORCID transport failures to orcid_search_failed', async () => {
    globalThis.fetch = fetchMock
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } }))
    const { dbPath } = tmpDb()
    const ctx = await harness(dbPath)
    const tool = ctx.tools.get('researcher_profile_disambiguate') as ToolDefinition
    const result = await tool.execute({
      family_name: 'Duan',
      given_name: 'Jinglai',
    }, fakeExec({ name: 'researcher_profile_disambiguate' })) as { ok: boolean; code: string }
    expect(result).toMatchObject({ ok: false, code: 'orcid_search_failed' })
    await ctx.fiber.dispose()
  })
})
