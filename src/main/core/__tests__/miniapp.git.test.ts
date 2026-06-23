import { describe, it, expect } from 'vitest'
import { ROUTES } from '../miniapp/routes/index'

describe('git route table', () => {
  it('has POST /api/git/update and it is ownerOnly', () => {
    const r = ROUTES.find((r) => r.method === 'POST' && r.path === '/api/git/update')
    expect(r).toBeDefined()
    expect(r?.ownerOnly).toBe(true)
  })
  it('has POST /api/git/push and it is ownerOnly', () => {
    const r = ROUTES.find((r) => r.method === 'POST' && r.path === '/api/git/push')
    expect(r).toBeDefined()
    expect(r?.ownerOnly).toBe(true)
  })
  it('has POST /api/git/apply and it is ownerOnly', () => {
    const r = ROUTES.find((r) => r.method === 'POST' && r.path === '/api/git/apply')
    expect(r).toBeDefined()
    expect(r?.ownerOnly).toBe(true)
  })
})
