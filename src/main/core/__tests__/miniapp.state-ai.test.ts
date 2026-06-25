import { describe, it, expect, vi } from 'vitest'

vi.mock('../supervisor', () => ({ listBots: async () => [] }))
vi.mock('../miniapp/authz', () => ({ botsVisibleTo: () => [], assertCap: () => ({}), can: () => false }))
vi.mock('../registry', () => ({ findEntry: () => undefined, readRegistry: () => [] }))
vi.mock('../telegramBot', () => ({ tailBotLogs: () => '' }))
vi.mock('../config', () => ({
  getAppConfig: () => ({}),
  setAutoApprove: () => {}, setAutoUpdateEnabled: () => {}, setNotifyConfig: () => {}, setAgentConfig: () => {},
  getAiUsage: (_uid: number, isHost: boolean) => ({ used: { chat: 0, ask: 3, fix: 0 }, limits: { chat: 30, ask: 20, fix: 1 }, unlimited: isHost })
}))

import { stateRoutes } from '../miniapp/routes/state'

function getState(auth: { userId: number; isOwner: boolean }) {
  const json = vi.fn()
  const route = stateRoutes.find((r) => r.path === '/api/state' && r.method === 'GET')!
  return Promise.resolve(route.handler({ auth, json, url: new URL('http://x/api/state'), body: {} } as never)).then(() => json.mock.calls[0][1] as Record<string, unknown>)
}

describe('state AI quota', () => {
  it('includes the requester ai quota (tenant)', async () => {
    const p = await getState({ userId: 7, isOwner: false })
    expect((p.ai as { used: { ask: number } }).used.ask).toBe(3)
    expect((p.ai as { unlimited: boolean }).unlimited).toBe(false)
  })
  it('marks host unlimited', async () => {
    const p = await getState({ userId: 1, isOwner: true })
    expect((p.ai as { unlimited: boolean }).unlimited).toBe(true)
  })
})
