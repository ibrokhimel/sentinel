/**
 * Task 5 — Tenant isolation on state + metrics routes.
 * Real authz runs (registry mocked, authz NOT mocked) so the test exercises
 * the actual chokepoint. service.ts maps ForbiddenError → 403; here we assert
 * the handler throws directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock registry so authz sees exactly two bots: a → tenant 7, b → host uid 1
vi.mock('../registry', () => ({
  readRegistry: () => [
    { id: 'a', name: 'A', dirName: 'a', ownerId: 7 },
    { id: 'b', name: 'B', dirName: 'b', ownerId: 1 }
  ],
  findEntry: (id: string) =>
    ({ a: { id: 'a', ownerId: 7 }, b: { id: 'b', ownerId: 1 } } as Record<string, unknown>)[id]
}))

// Mock supervisor
vi.mock('../supervisor', () => ({
  listBots: vi.fn(async () => [
    { manifest: { id: 'a' }, state: 'running' },
    { manifest: { id: 'b' }, state: 'running' }
  ]),
  getEnv: vi.fn(() => ({ keys: ['FOO'], current: { FOO: 'bar' } })),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  restart: vi.fn(async () => {}),
  setAutostart: vi.fn(async () => {}),
  getBot: vi.fn(async (_id: string) => ({ manifest: { id: _id }, state: 'running' })),
  saveEnv: vi.fn(async () => {})
}))

// Mock telegramBot
vi.mock('../telegramBot', () => ({
  tailBotLogs: vi.fn((_id: string, _n: number) => 'some log text')
}))

// Mock monitor
vi.mock('../monitor', () => ({
  getMetrics: vi.fn((_id: string, _n: number) => [])
}))

// Mock config
vi.mock('../config', () => ({
  getAppConfig: vi.fn(() => ({ version: '1.0', autoUpdate: false })),
  setAutoApprove: vi.fn(),
  setAutoUpdateEnabled: vi.fn(),
  setNotifyConfig: vi.fn(),
  setAgentConfig: vi.fn(),
  getAiUsage: vi.fn((_uid: number, isHost: boolean) => ({ used: { chat: 0, ask: 0, fix: 0 }, limits: { chat: 30, ask: 20, fix: 1 }, unlimited: isHost }))
}))

import { stateRoutes } from '../miniapp/routes/state'
import { metricsRoutes } from '../miniapp/routes/metrics'
import { ForbiddenError } from '../miniapp/authz'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(
  auth: { userId: number; isOwner: boolean },
  overrides: { body?: Record<string, unknown>; searchParams?: Record<string, string> } = {}
) {
  const json = vi.fn()
  const params = new URLSearchParams(overrides.searchParams ?? {})
  const url = new URL('http://localhost/?' + params.toString())
  return {
    ctx: { auth, body: overrides.body ?? {}, json, url } as never,
    json
  }
}

function stateRoute(path: string) {
  const r = stateRoutes.find((r) => r.path === path)
  if (!r) throw new Error(`Route not found: ${path}`)
  return r
}

function metricsRoute(path: string) {
  const r = metricsRoutes.find((r) => r.path === path)
  if (!r) throw new Error(`Route not found: ${path}`)
  return r
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// /api/state — visibility filtering
// ---------------------------------------------------------------------------

describe('/api/state visibility filtering', () => {
  it('tenant (uid=7) sees only bot "a"', async () => {
    const { ctx, json } = makeCtx({ userId: 7, isOwner: false })
    await stateRoute('/api/state').handler(ctx)
    const payload = json.mock.calls[0][1] as { bots: Array<{ manifest: { id: string } }> }
    expect(payload.bots.map((b) => b.manifest.id)).toEqual(['a'])
  })

  it('host sees both bots "a" and "b"', async () => {
    const { ctx, json } = makeCtx({ userId: 1, isOwner: true })
    await stateRoute('/api/state').handler(ctx)
    const payload = json.mock.calls[0][1] as { bots: Array<{ manifest: { id: string } }> }
    expect(payload.bots.map((b) => b.manifest.id).sort()).toEqual(['a', 'b'])
  })

  it('tenant payload has config === null', async () => {
    const { ctx, json } = makeCtx({ userId: 7, isOwner: false })
    await stateRoute('/api/state').handler(ctx)
    const payload = json.mock.calls[0][1] as { config: unknown }
    expect(payload.config).toBeNull()
  })

  it('host payload has non-null config', async () => {
    const { ctx, json } = makeCtx({ userId: 1, isOwner: true })
    await stateRoute('/api/state').handler(ctx)
    const payload = json.mock.calls[0][1] as { config: unknown }
    expect(payload.config).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// /api/logs — viewLogs capability
// ---------------------------------------------------------------------------

describe('/api/logs capability gate', () => {
  it('tenant (uid=7) denied access to bot "b" logs', async () => {
    const { ctx } = makeCtx({ userId: 7, isOwner: false }, { searchParams: { id: 'b' } })
    await expect(stateRoute('/api/logs').handler(ctx)).rejects.toThrow(ForbiddenError)
  })

  it('tenant (uid=7) can access own bot "a" logs', async () => {
    const { ctx, json } = makeCtx({ userId: 7, isOwner: false }, { searchParams: { id: 'a' } })
    await stateRoute('/api/logs').handler(ctx)
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ text: expect.any(String) }))
  })
})

// ---------------------------------------------------------------------------
// /api/env GET — editEnv capability
// ---------------------------------------------------------------------------

describe('/api/env GET capability gate', () => {
  it('tenant (uid=7) denied access to bot "b" env', async () => {
    const { ctx } = makeCtx({ userId: 7, isOwner: false }, { searchParams: { id: 'b' } })
    expect(() => stateRoute('/api/env').handler(ctx)).toThrow(ForbiddenError)
  })

  it('tenant (uid=7) can access own bot "a" env', async () => {
    const { ctx, json } = makeCtx({ userId: 7, isOwner: false }, { searchParams: { id: 'a' } })
    stateRoute('/api/env').handler(ctx)
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ keys: expect.any(Array) }))
  })
})

// ---------------------------------------------------------------------------
// /api/action POST — startStop capability
// ---------------------------------------------------------------------------

describe('/api/action POST capability gate', () => {
  it('tenant (uid=7) denied action on bot "b"', async () => {
    const { ctx } = makeCtx(
      { userId: 7, isOwner: false },
      { body: { id: 'b', action: 'start' } }
    )
    await expect(stateRoute('/api/action').handler(ctx)).rejects.toThrow(ForbiddenError)
  })

  it('tenant (uid=7) can start own bot "a"', async () => {
    const { ctx, json } = makeCtx(
      { userId: 7, isOwner: false },
      { body: { id: 'a', action: 'start' } }
    )
    await stateRoute('/api/action').handler(ctx)
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ ok: true }))
  })
})

// ---------------------------------------------------------------------------
// /api/metrics GET — view capability
// ---------------------------------------------------------------------------

describe('/api/metrics capability gate', () => {
  it('tenant (uid=7) denied metrics for bot "b"', async () => {
    const { ctx } = makeCtx({ userId: 7, isOwner: false }, { searchParams: { id: 'b' } })
    expect(() => metricsRoute('/api/metrics').handler(ctx)).toThrow(ForbiddenError)
  })

  it('tenant (uid=7) can read metrics for own bot "a"', async () => {
    const { ctx, json } = makeCtx({ userId: 7, isOwner: false }, { searchParams: { id: 'a' } })
    metricsRoute('/api/metrics').handler(ctx)
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ samples: expect.any(Array) }))
  })
})
