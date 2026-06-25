import { describe, it, expect, vi } from 'vitest'
import { botRoutes } from '../miniapp/routes/bots'

describe('bot routes', () => {
  it('registers import/remove/upload with per-bot authz (ownerOnly:false)', () => {
    // ownerOnly was changed to false by prior task; per-bot assertCap inside handler enforces ownership
    for (const p of ['/api/bots/import', '/api/bots/remove', '/api/bots/upload'])
      expect(botRoutes.find((r) => r.path === p)?.ownerOnly).toBe(false)
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
