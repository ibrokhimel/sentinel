import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as configModule from '../config'
import * as sessionsModule from '../miniapp/sessions'
import * as runtimeModule from '../agent/runtime'
import * as registryModule from '../registry'
import * as supervisorModule from '../supervisor'
import { chatRoutes } from '../miniapp/routes/chat'

const checkAndCountAi = vi.fn(() => ({ ok: true, remaining: 5 }))
const runAgent = vi.fn(async () => 'ok')

// Spy/replace functions
vi.spyOn(configModule, 'getAgentConfig').mockReturnValue({ baseUrl: 'http://x', apiKey: 'k', model: 'm', ready: true })
vi.spyOn(configModule, 'getAppConfig').mockReturnValue({
  notify: { enabled: false, hasToken: false, chatId: '' },
  control: { enabled: false, ready: false },
  agent: { baseUrl: 'http://x', model: 'm', hasKey: true, ready: true },
  autoApprove: false,
  autoUpdateEnabled: false,
  backgroundAgent: false,
  approvedUsers: [],
  pendingUsers: [],
  ignoredUsers: [],
  userProfiles: {},
  limits: { maxBotsPerTenant: 5, aiPerDay: { chat: 30, ask: 20, fix: 1 } }
} as any)
vi.spyOn(configModule, 'checkAndCountAi').mockImplementation(checkAndCountAi)
vi.spyOn(runtimeModule, 'runAgent').mockImplementation(runAgent)
vi.spyOn(registryModule, 'findEntry').mockReturnValue({ id: 'a', botId: 'a', access: 'owner' } as any)
vi.spyOn(supervisorModule, 'getBot').mockImplementation(async () => ({ manifest: { id: 'a' }, dir: '/tmp' } as any))

const mockSession = {
  id: 'a:7',
  title: 'Test',
  botId: 'a',
  mode: 'ask' as const,
  messages: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ownerId: 7
}
vi.spyOn(sessionsModule, 'getSessionFor').mockReturnValue(mockSession)

function streamCtx(auth: { userId: number; isOwner: boolean }) {
  const writes: string[] = []
  const res: Record<string, unknown> = {
    writeHead: () => {}, write: (s: string) => { writes.push(s); return true }, end: () => {}, on: () => {}, writableEnded: false
  }
  const route = chatRoutes.find((r) => r.path === '/api/chat/stream')!
  return { p: route.handler({ auth, res, body: { message: 'hi' }, json: () => {} } as never), writes }
}

describe('chat AI metering', () => {
  beforeEach(() => { runAgent.mockClear(); checkAndCountAi.mockReset(); checkAndCountAi.mockReturnValue({ ok: true, remaining: 5 }) })

  it('runs the agent when under the cap (kind=ask)', async () => {
    const { p } = streamCtx({ userId: 7, isOwner: true })
    await p
    expect(checkAndCountAi).toHaveBeenCalledWith(7, true, 'ask')
    expect(runAgent).toHaveBeenCalled()
  })

  it('refuses and does NOT run the agent when over the cap', async () => {
    checkAndCountAi.mockReturnValue({ ok: false, remaining: 0 })
    const { p, writes } = streamCtx({ userId: 7, isOwner: true })
    await p
    expect(runAgent).not.toHaveBeenCalled()
    expect(writes.join('')).toMatch(/limit reached/i)
  })
})
