import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock paths resolve relative to THIS test file (src/main/core/__tests__/),
// so '../supervisor' === the module bots.ts imports as '../../supervisor'.
vi.mock('../supervisor', () => ({
  importBot: vi.fn(async () => ({ bot: { manifest: { id: 'newbot' } } })),
  removeBot: vi.fn(async () => undefined)
}))
const owned = vi.fn((): unknown[] => [])
vi.mock('../registry', () => ({
  botsOwnedBy: (_uid: number) => owned(),
  setBotOwner: vi.fn(),
  findEntry: (id: string) => (id === 'mine' ? { id, ownerId: 7 } : { id, ownerId: 999 })
}))
vi.mock('../config', () => ({ getLimits: () => ({ maxBotsPerTenant: 2, aiPerDay: { chat: 1, ask: 1, fix: 1 } }) }))

import { botRoutes } from '../miniapp/routes/bots'
import * as sup from '../supervisor'
import * as reg from '../registry'

function run(path: string, body: unknown, auth: { userId: number; isOwner: boolean }) {
  const json = vi.fn()
  const route = botRoutes.find((r) => r.path === path)!
  return { p: route.handler({ body, json, auth } as never), json }
}

describe('bots tenancy', () => {
  beforeEach(() => owned.mockReturnValue([]))

  it('blocks a tenant who is at their bot quota', async () => {
    owned.mockReturnValue([{}, {}]) // 2 == maxBotsPerTenant
    const { p, json } = run('/api/bots/import', { url: 'https://x/y.git' }, { userId: 7, isOwner: false })
    await p
    expect(json).toHaveBeenCalledWith(403, expect.objectContaining({ error: expect.stringMatching(/limit/i) }))
  })

  it('lets a tenant import below quota and stamps ownership', async () => {
    const { p, json } = run('/api/bots/import', { url: 'https://x/y.git' }, { userId: 7, isOwner: false })
    await p
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ ok: true, id: 'newbot' }))
    expect(reg.setBotOwner).toHaveBeenCalledWith('newbot', 7)
  })

  it('forbids removing a bot the tenant does not own', async () => {
    const { p, json } = run('/api/bots/remove', { id: 'notmine', confirm: true }, { userId: 7, isOwner: false })
    await p
    expect(json).toHaveBeenCalledWith(403, expect.objectContaining({ error: expect.any(String) }))
  })

  it('bypasses tenant quota for host import', async () => {
    owned.mockReturnValue([{}, {}]) // 2 == maxBotsPerTenant (at limit)
    const { p, json } = run('/api/bots/import', { url: 'https://x/y.git' }, { userId: 1, isOwner: true })
    await p
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ ok: true, id: 'newbot' }))
  })

  it('cleans up orphaned bot if stamp fails', async () => {
    ;(reg.setBotOwner as any).mockImplementationOnce(() => {
      throw new Error('disk')
    })
    const { p, json } = run('/api/bots/import', { url: 'https://x/y.git' }, { userId: 7, isOwner: false })
    await p
    expect(json).toHaveBeenCalledWith(500, expect.objectContaining({ error: expect.stringMatching(/ownership/) }))
    expect(sup.removeBot).toHaveBeenCalledWith('newbot')
  })
})
