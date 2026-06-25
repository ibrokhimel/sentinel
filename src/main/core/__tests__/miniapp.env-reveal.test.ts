import { describe, it, expect, vi } from 'vitest'

vi.mock('../supervisor', () => ({
  getEnv: () => ({ keys: ['NAME', 'API_TOKEN'], current: { NAME: 'bot', API_TOKEN: 'secret-123' } })
}))
// a: owner 7, collaborator 2 has viewSecrets; collaborator 3 has editEnv only
vi.mock('../registry', () => ({
  findEntry: () => ({ id: 'a', ownerId: 7, collaborators: { '2': { editEnv: true, viewSecrets: true }, '3': { editEnv: true } } })
}))
vi.mock('../../telegramBot', () => ({ tailBotLogs: () => '' }))
vi.mock('../../config', () => ({ getAppConfig: () => ({}), setAutoApprove: () => {}, setAutoUpdateEnabled: () => {}, setNotifyConfig: () => {}, setAgentConfig: () => {} }))

import { stateRoutes } from '../miniapp/routes/state'

function getEnv(auth: { userId: number; isOwner: boolean }) {
  const json = vi.fn()
  const route = stateRoutes.find((r) => r.path === '/api/env' && r.method === 'GET')!
  route.handler({ auth, json, url: new URL('http://x/api/env?id=a'), body: {} } as never)
  return json.mock.calls[0][1] as { current: Record<string, string>; secretKeys: string[] }
}

describe('env secret reveal', () => {
  it('reveals secrets to a viewSecrets collaborator', () => {
    const p = getEnv({ userId: 2, isOwner: false })
    expect(p.current.API_TOKEN).toBe('secret-123')
    expect(p.current.NAME).toBe('bot')
  })
  it('masks secrets for an editEnv-only collaborator', () => {
    const p = getEnv({ userId: 3, isOwner: false })
    expect(p.current.API_TOKEN).toBe('')
    expect(p.secretKeys).toContain('API_TOKEN')
  })
  it('reveals secrets to the host', () => {
    expect(getEnv({ userId: 1, isOwner: true }).current.API_TOKEN).toBe('secret-123')
  })
})
