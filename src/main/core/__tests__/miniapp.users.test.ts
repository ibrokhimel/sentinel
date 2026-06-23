import { describe, it, expect, vi } from 'vitest'
import { userRoutes } from '../miniapp/routes/users'

describe('user routes', () => {
  it('GET /api/users lists approved; approve/revoke owner-only', () => {
    expect(userRoutes.find((r) => r.path === '/api/users' && r.method === 'GET')?.ownerOnly).toBe(true)
    expect(userRoutes.find((r) => r.path === '/api/users/approve')?.ownerOnly).toBe(true)
    expect(userRoutes.find((r) => r.path === '/api/users/revoke')?.ownerOnly).toBe(true)
  })

  it('approve returns 400 for missing/NaN userId', async () => {
    const json = vi.fn()
    const approveRoute = userRoutes.find((r) => r.path === '/api/users/approve')!
    await approveRoute.handler({ body: {}, json } as any)
    expect(json).toHaveBeenCalledWith(400, expect.objectContaining({ error: expect.any(String) }))
  })

  it('revoke returns 400 for missing/NaN userId', async () => {
    const json = vi.fn()
    const revokeRoute = userRoutes.find((r) => r.path === '/api/users/revoke')!
    await revokeRoute.handler({ body: {}, json } as any)
    expect(json).toHaveBeenCalledWith(400, expect.objectContaining({ error: expect.any(String) }))
  })
})
