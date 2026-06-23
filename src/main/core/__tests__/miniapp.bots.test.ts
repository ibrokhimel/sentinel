import { describe, it, expect, vi } from 'vitest'
import { botRoutes } from '../miniapp/routes/bots'

describe('bot routes', () => {
  it('registers import/remove/upload owner-only', () => {
    for (const p of ['/api/bots/import', '/api/bots/remove', '/api/bots/upload'])
      expect(botRoutes.find((r) => r.path === p)?.ownerOnly).toBe(true)
  })
  it('remove requires confirm:true', async () => {
    const json = vi.fn()
    await botRoutes.find((r) => r.path === '/api/bots/remove')!.handler({
      body: { id: 'x', confirm: false },
      json
    } as any)
    expect(json).toHaveBeenCalledWith(400, expect.objectContaining({ error: expect.any(String) }))
  })
})
