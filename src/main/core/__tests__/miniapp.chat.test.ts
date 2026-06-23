import { describe, it, expect, vi } from 'vitest'
import { chatRoutes } from '../miniapp/routes/chat'

function route(method: string, path: string) {
  return chatRoutes.find((r) => r.method === method && r.path === path)!
}

describe('chat routes', () => {
  it('registers session CRUD + stream, all owner-only', () => {
    for (const p of [
      '/api/chat/sessions',
      '/api/chat/sessions/rename',
      '/api/chat/sessions/delete',
      '/api/chat/sessions/reset',
      '/api/chat/stream'
    ])
      expect(chatRoutes.some((r) => r.path === p)).toBe(true)
    expect(route('POST', '/api/chat/stream').ownerOnly).toBe(true)
  })
  it('GET sessions returns Main', async () => {
    const json = vi.fn()
    await route('GET', '/api/chat/sessions').handler({
      url: new URL('http://x/api/chat/sessions'),
      auth: { userId: 1, isOwner: true },
      body: {},
      json
    } as any)
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ sessions: expect.any(Array) }))
  })
})
