import { describe, it, expect, vi } from 'vitest'

vi.mock('../registry', () => ({
  // a: owned by 7, collaborator 2 ; b: owned by 1 (host) collaborator 7 ; c: owned by 9 (someone else), no rel to 7
  readRegistry: () => [
    { id: 'a', name: 'A', dirName: 'a', ownerId: 7, collaborators: { '2': { viewLogs: true } } },
    { id: 'b', name: 'B', dirName: 'b', ownerId: 1, collaborators: { '7': { chat: true } } },
    { id: 'c', name: 'C', dirName: 'c', ownerId: 9, collaborators: {} }
  ],
  findEntry: () => undefined,
  setCollaborator: vi.fn(),
  removeCollaborator: vi.fn()
}))
vi.mock('../config', () => ({
  getApprovedProfiles: () => [ { id: 1, username: 'host' }, { id: 7, username: 'me' }, { id: 2, username: 'bob' }, { id: 3, username: 'sam' } ],
  getApprovedUsers: () => [1, 7, 2, 3],
  getUserProfile: (id: number) => ({ id, username: 'u' + id }),
  getHostUid: () => 1
}))

import { collaboratorRoutes } from '../miniapp/routes/collaborators'

function call(auth: { userId: number; isOwner: boolean }) {
  const json = vi.fn()
  const route = collaboratorRoutes.find((r) => r.path === '/api/collaborations' && r.method === 'GET')!
  return Promise.resolve(route.handler({ auth, json, url: new URL('http://x/api/collaborations'), body: {} } as never))
    .then(() => json.mock.calls[0][1] as { owned: Array<{ id: string; collaborators: unknown[]; addable: { id: number }[] }>; shared: Array<{ id: string; caps: unknown; owner: { id: number } }> })
}

describe('GET /api/collaborations', () => {
  it('tenant: owns a (with collaborator 2), is shared b', async () => {
    const p = await call({ userId: 7, isOwner: false })
    expect(p.owned.map((o) => o.id)).toEqual(['a'])
    expect(p.owned[0].collaborators.length).toBe(1)
    expect(p.owned[0].addable.map((u) => u.id).sort()).toEqual([3]) // excludes host(1), owner(7), existing(2)
    expect(p.shared.map((s) => s.id)).toEqual(['b'])
    expect(p.shared[0].owner.id).toBe(1)
  })
  it('host sees all bots under owned, none shared', async () => {
    const p = await call({ userId: 1, isOwner: true })
    expect(p.owned.map((o) => o.id).sort()).toEqual(['a', 'b', 'c'])
    expect(p.shared).toEqual([])
  })
  it('user with neither gets empty arrays', async () => {
    const p = await call({ userId: 42, isOwner: false })
    expect(p.owned).toEqual([])
    expect(p.shared).toEqual([])
  })
})
