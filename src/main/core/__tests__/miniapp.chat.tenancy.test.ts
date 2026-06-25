/**
 * Chat tenancy guards — unit tests (mocked sessions + registry).
 * Tests session-CRUD ownership enforcement and create-visibility guard.
 * Does NOT simulate SSE streams.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- registry mock -------------------------------------------------------
// Bot 'a' is owned by uid 7; bot 'b' is owned by host uid 1.
// uid 9 is a collaborator on bot 'a' with viewLogs only (no chat).
vi.mock('../../registry', () => {
  const entryA = { id: 'a', ownerId: 7, collaborators: { '9': { viewLogs: true } } }
  const entryB = { id: 'b', ownerId: 1, collaborators: {} }
  return {
    readRegistry: () => [entryA, entryB],
    findEntry: (id: string) => (id === 'a' ? entryA : id === 'b' ? entryB : undefined)
  }
})

// ---- sessions mock -------------------------------------------------------
vi.mock('../miniapp/sessions', () => {
  const sess7 = { id: 'sess-7', title: 't7', botId: 'a', mode: 'ask', ownerId: 7, messages: [], createdAt: 0, updatedAt: 0 }
  const sess8 = { id: 'sess-8', title: 't8', botId: 'b', mode: 'ask', ownerId: 8, messages: [], createdAt: 0, updatedAt: 0 }
  return {
    listSessions: vi.fn((uid: number) => (uid === 7 ? [sess7] : [sess8])),
    getSessionFor: vi.fn((uid: number, id: string) => {
      if (uid === 7 && id === 'sess-7') return sess7
      if (uid === 8 && id === 'sess-8') return sess8
      return null
    }),
    createSession: vi.fn((o: { ownerId: number; botId: string | null; mode: string; title?: string }) => ({
      ...o,
      id: 'new-sess',
      messages: [],
      createdAt: 0,
      updatedAt: 0
    })),
    renameSession: vi.fn((id: string, title: string) => (id === 'sess-7' ? { id, title } : null)),
    deleteSession: vi.fn((id: string) => id === 'sess-7'),
    resetSession: vi.fn((id: string) => (id === 'sess-7' ? { id, messages: [] } : null)),
    mainIdFor: vi.fn((uid: number) => `main:${uid}`),
    appendTurn: vi.fn(),
    getSession: vi.fn(),
    MAIN_ID: 'main'
  }
})

// ---- other deps mocked so import doesn't blow up -------------------------
vi.mock('../../supervisor', () => ({ getBot: vi.fn() }))
vi.mock('../../config', () => ({
  getAgentConfig: vi.fn(() => ({ baseUrl: '', apiKey: '', model: '', ready: false })),
  getAppConfig: vi.fn(() => ({ autoApprove: false }))
}))
vi.mock('../../agent/runtime', () => ({ runAgent: vi.fn() }))

import { chatRoutes } from '../miniapp/routes/chat'
import * as SessionsMock from '../miniapp/sessions'

function route(method: string, path: string) {
  return chatRoutes.find((r) => r.method === method && r.path === path)!
}

function ctx(userId: number, isOwner: boolean, body: Record<string, unknown> = {}, params: Record<string, string> = {}) {
  const url = new URL('http://x/api/chat/sessions')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return {
    url,
    auth: { userId, isOwner },
    body,
    json: vi.fn(),
    res: { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn(), writableEnded: false }
  } as any
}

describe('chat tenancy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // (a) GET sessions passes auth.userId to listSessions
  it('GET /api/chat/sessions passes userId to listSessions', async () => {
    const c = ctx(7, false)
    await route('GET', '/api/chat/sessions').handler(c)
    expect(SessionsMock.listSessions).toHaveBeenCalledWith(7, undefined)
    expect(c.json).toHaveBeenCalledWith(200, expect.objectContaining({ sessions: expect.any(Array) }))
  })

  // (b) creating an 'ask' session on a non-visible bot (tenant 7 for bot 'b') is rejected
  it('POST /api/chat/sessions rejects ask on a non-visible bot', async () => {
    // bot 'b' is owned by host (uid 1), uid 7 (non-host) has no access
    const c = ctx(7, false, { botId: 'b', mode: 'ask', title: 'test' })
    let threw = false
    try {
      await route('POST', '/api/chat/sessions').handler(c)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // createSession must NOT have been called
    expect(SessionsMock.createSession).not.toHaveBeenCalled()
  })

  // (c) rename on a session not owned returns 404
  it('POST /api/chat/sessions/rename returns 404 for non-owned session', async () => {
    // uid 8 tries to rename sess-7 (owned by uid 7) — getSessionFor(8, 'sess-7') returns null
    const c = ctx(8, false, { id: 'sess-7', title: 'hacked' })
    await route('POST', '/api/chat/sessions/rename').handler(c)
    expect(c.json).toHaveBeenCalledWith(404, expect.objectContaining({ error: 'not found' }))
    expect(SessionsMock.renameSession).not.toHaveBeenCalled()
  })

  // (c) delete on a session not owned returns 404
  it('POST /api/chat/sessions/delete returns 404 for non-owned session', async () => {
    // uid 8 tries to delete sess-7 (owned by uid 7) — getSessionFor(8, 'sess-7') returns null
    const c = ctx(8, false, { id: 'sess-7' })
    await route('POST', '/api/chat/sessions/delete').handler(c)
    expect(c.json).toHaveBeenCalledWith(404, expect.objectContaining({ error: 'not found' }))
    expect(SessionsMock.deleteSession).not.toHaveBeenCalled()
  })

  // (c2) creating an 'ask' session for a collaborator with viewLogs but NOT chat is denied
  it('POST /api/chat/sessions rejects ask for collaborator without chat capability', async () => {
    // uid 9 has viewLogs on bot 'a' but not chat — assertCap('chat') must throw ForbiddenError
    const c = ctx(9, false, { botId: 'a', mode: 'ask', title: 'test' })
    let threw = false
    try {
      await route('POST', '/api/chat/sessions').handler(c)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(SessionsMock.createSession).not.toHaveBeenCalled()
  })

  // (d) confirm rejects an unknown/foreign token
  it('POST /api/chat/confirm rejects an unknown/foreign token', async () => {
    const c = ctx(7, false, { token: 'nope', approve: true })
    await route('POST', '/api/chat/confirm').handler(c)
    expect(c.json).toHaveBeenCalledWith(404, expect.objectContaining({ error: expect.any(String) }))
  })
})
