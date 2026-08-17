/**
 * Real-composition tests: the literature plugin mounted over the standard
 * agent-loop test dependencies, asserting the Loader-safe export shape, the
 * ctx.literature service, the three registered tools, tool execution through
 * the registry, and the sandbox-policy grant.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as literature from '../src/index.ts'

function fakeExec(overrides: Record<string, unknown> = {}): ToolRunContext {
  return {
    callId: 'test-call',
    rootCallId: 'test-call',
    name: 'literature_search',
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
  const dir = mkdtempSync(join(tmpdir(), 'dsh-literature-plugin-'))
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
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe('literature plugin', () => {
  it('has the Loader-safe function-plugin export shape', () => {
    expect('default' in literature).toBe(false)
    expect(literature.name).toBe('literature-search')
    expect(literature.inject).toEqual(['tools', 'systemPrompt', 'skills'])
  })

  it('provides ctx.literature and registers all three tools', async () => {
    const { dbPath } = tmpDb()
    const ctx = await harness(dbPath)
    expect(ctx.literature).toBeDefined()
    expect(ctx.literature.db.path).toBe(dbPath)
    expect(ctx.tools.get('literature_search')).toBeDefined()
    expect(ctx.tools.get('literature_get')).toBeDefined()
    expect(ctx.tools.get('literature_db')).toBeDefined()
    expect(ctx.tools.get('tracking_plan_add')).toBeDefined()
    expect(ctx.tools.get('tracking_search')).toBeDefined()
    expect(ctx.tools.get('tracking_curate')).toBeDefined()
    expect(ctx.tools.get('tracking_log_complete')).toBeDefined()
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(
      expect.arrayContaining(['literature-tracking-setup', 'literature-tracking-search']),
    )
    await ctx.fiber.dispose()
  })

  it('executes literature_search over the local database through the registry', async () => {
    const { dbPath } = tmpDb()
    const ctx = await harness(dbPath)
    ctx.literature.db.upsertPaper({
      doi: '10.1000/compose',
      title: 'Composition search hit',
      authors: JSON.stringify(['Composer']),
      year: 2021,
    })
    const tool = ctx.tools.get('literature_search') as ToolDefinition
    const value = await tool.execute(
      { query: 'composition', sources: 'local' },
      fakeExec({ name: 'literature_search' }),
    ) as { ok: boolean; papers: { doi: string }[]; total: number }
    expect(value.ok).toBe(true)
    expect(value.total).toBe(1)
    expect(value.papers[0]?.doi).toBe('10.1000/compose')
    await ctx.fiber.dispose()
  })

  it('executes literature_get with a cached hit and literature_db stats', async () => {
    const { dbPath } = tmpDb()
    const ctx = await harness(dbPath)
    ctx.literature.db.upsertPaper({ doi: '10.1000/cached', title: 'Cached paper', year: 2020 })

    const getTool = ctx.tools.get('literature_get') as ToolDefinition
    const got = await getTool.execute(
      { doi: '10.1000/cached' },
      fakeExec({ name: 'literature_get' }),
    ) as { ok: boolean; cached: boolean; paper: { title: string } }
    expect(got).toMatchObject({ ok: true, cached: true, paper: { title: 'Cached paper' } })

    const dbTool = ctx.tools.get('literature_db') as ToolDefinition
    const stats = await dbTool.execute(
      { action: 'stats' },
      fakeExec({ name: 'literature_db' }),
    ) as { ok: boolean; action: string; paperCount: number }
    expect(stats).toMatchObject({ ok: true, action: 'stats', paperCount: 1 })

    // DOI lookup failure mapping (not_found) is covered with stubs in
    // tests/engine.spec.ts; the composition suite stays hermetic (no network).
    await ctx.fiber.dispose()
  })

  it('grants the literature data directory as an extra writable root', async () => {
    const { dir, dbPath } = tmpDb()
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry, {})
    await ctx.plugin(literature, { enabled: true, dbPath })

    const handle = await ctx.agents.create({
      sessionId: SessionId('lit-grant-session'),
      meta: { cwd: process.cwd(), agentPreset: 'standard' },
    })
    const policy = ctx.sandboxPolicy.resolve({ session: handle.agent.session })
    expect(policy.extraWriteRoots).toContain(realpathSync(dir))
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('still loads when sandboxPolicy exists but has no grant()', async () => {
    const { dbPath } = tmpDb()
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SkillRegistry, {})
    ctx.provide('sandboxPolicy', { resolve() { return { mode: 'danger-full-access', workspaceRoot: process.cwd() } } })
    await ctx.plugin(literature, { enabled: true, dbPath })
    expect(ctx.literature).toBeDefined()
    expect(ctx.tools.get('literature_search')).toBeDefined()
    expect(ctx.tools.get('tracking_search')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('stays inert when enabled is not true, so other presets get no literature tools', async () => {
    const { dbPath } = tmpDb()
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SkillRegistry, {})
    await ctx.plugin(literature, { dbPath })
    expect(ctx.get('literature')).toBeUndefined()
    expect(ctx.tools.get('literature_search')).toBeUndefined()
    expect(ctx.tools.get('tracking_search')).toBeUndefined()
    expect((await ctx.skills.list()).map(skill => skill.name)).not.toEqual(
      expect.arrayContaining(['literature-tracking-setup', 'literature-tracking-search']),
    )
    await ctx.fiber.dispose()
  })
})
