import { describe, it, expect } from 'vitest'
import { ROUTES } from '../miniapp/routes/index'

describe('route table', () => {
  it('exposes the existing endpoints with correct methods + owner gating', () => {
    const find = (m: string, p: string) => ROUTES.find((r) => r.method === m && r.path === p)
    expect(find('GET', '/api/state')?.ownerOnly).toBe(false)
    expect(find('GET', '/api/logs')?.ownerOnly).toBe(false)
    expect(find('GET', '/api/env')?.ownerOnly).toBe(false)
    expect(find('POST', '/api/action')?.ownerOnly).toBe(false) // per-bot assertCap enforces ownership
    expect(find('POST', '/api/env')?.ownerOnly).toBe(false) // per-bot assertCap enforces ownership
    expect(find('POST', '/api/settings')?.ownerOnly).toBe(true)
  })
  it('has no duplicate method+path', () => {
    const seen = new Set<string>()
    for (const r of ROUTES) {
      const k = r.method + ' ' + r.path
      expect(seen.has(k)).toBe(false)
      seen.add(k)
    }
  })
})
