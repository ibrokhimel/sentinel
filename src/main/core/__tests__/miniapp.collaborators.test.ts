import { describe, it, expect, vi, beforeEach } from 'vitest'

const set = vi.fn()
const remove = vi.fn()
let entry: Record<string, unknown> | undefined
vi.mock('../registry', () => ({
  findEntry: () => entry,
  setCollaborator: (...a: unknown[]) => set(...a),
  removeCollaborator: (...a: unknown[]) => remove(...a)
}))
vi.mock('../config', () => ({
  getApprovedProfiles: () => [
    { id: 1, username: 'host' }, { id: 7, username: 'owner' },
    { id: 2, username: 'bob' }, { id: 3, username: 'sam' }
  ],
  getApprovedUsers: () => [1, 7, 2, 3],
  getUserProfile: (id: number) => ({ id, username: 'u' + id }),
  getHostUid: () => 1
}))

import { collaboratorRoutes } from '../miniapp/routes/collaborators'

function call(path: string, method: string, body: unknown, auth: { userId: number; isOwner: boolean }, query = '') {
  const json = vi.fn()
  const route = collaboratorRoutes.find((r) => r.path === path && r.method === method)!
  const url = new URL('http://x' + path + query)
  return Promise.resolve(route.handler({ body, json, auth, url } as never)).then(() => json)
}

describe('collaborator routes', () => {
  beforeEach(() => { set.mockClear(); remove.mockClear(); entry = { id: 'a', ownerId: 7, collaborators: { '2': { viewLogs: true } } } })

  it('GET lists collaborators + addable tenants (excludes host/owner/existing)', async () => {
    const json = await call('/api/bots/collaborators', 'GET', {}, { userId: 7, isOwner: false }, '?botId=a')
    const payload = json.mock.calls[0][1] as { collaborators: { id: number }[]; addable: { id: number }[] }
    expect(payload.collaborators.map((c) => c.id)).toEqual([2])
    expect(payload.addable.map((u) => u.id).sort()).toEqual([3]) // 1=host,7=owner,2=existing excluded
  })

  it('GET is forbidden for a non-owner non-host', async () => {
    const json = await call('/api/bots/collaborators', 'GET', {}, { userId: 99, isOwner: false }, '?botId=a')
    expect(json).toHaveBeenCalledWith(403, expect.objectContaining({ error: expect.any(String) }))
  })

  it('owner can add a collaborator with coerced caps', async () => {
    const json = await call('/api/bots/collaborators', 'POST', { botId: 'a', userId: 3, capabilities: { viewLogs: true } }, { userId: 7, isOwner: false })
    expect(set).toHaveBeenCalledWith('a', 3, { viewLogs: true })
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ ok: true }))
  })

  it('a non-owner non-host tenant is forbidden', async () => {
    const json = await call('/api/bots/collaborators', 'POST', { botId: 'a', userId: 3, capabilities: {} }, { userId: 99, isOwner: false })
    expect(json).toHaveBeenCalledWith(403, expect.objectContaining({ error: expect.any(String) }))
    expect(set).not.toHaveBeenCalled()
  })

  it('rejects adding a non-approved user', async () => {
    const json = await call('/api/bots/collaborators', 'POST', { botId: 'a', userId: 555, capabilities: {} }, { userId: 7, isOwner: false })
    expect(json).toHaveBeenCalledWith(400, expect.objectContaining({ error: expect.any(String) }))
  })

  it('owner can remove a collaborator', async () => {
    const json = await call('/api/bots/collaborators/remove', 'POST', { botId: 'a', userId: 2 }, { userId: 7, isOwner: false })
    expect(remove).toHaveBeenCalledWith('a', 2)
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ ok: true }))
  })
})
