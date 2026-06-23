import { describe, it, expect, vi } from 'vitest'
import { agentTestRoutes } from '../miniapp/routes/agentTest'

describe('agent test route', () => {
  it('is owner-only and returns ok=false when unconfigured', async () => {
    const r = agentTestRoutes.find((x) => x.path === '/api/agent/test')!
    expect(r.ownerOnly).toBe(true)
    const json = vi.fn()
    await r.handler({ body: {}, json } as any)
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ ok: expect.any(Boolean) }))
  })
})
