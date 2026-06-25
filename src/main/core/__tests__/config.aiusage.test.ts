import { describe, it, expect, beforeEach, vi } from 'vitest'

const files = new Map<string, string>()
vi.mock('node:fs', () => ({
  existsSync: (p: string) => files.has(p),
  readFileSync: (p: string) => {
    const v = files.get(p)
    if (v === undefined) throw new Error('ENOENT ' + p)
    return v
  },
  writeFileSync: (p: string, d: string) => void files.set(p, d),
  mkdirSync: () => undefined
}))

import { SENTINEL_HOME } from '../paths'
import { join } from 'node:path'
import { checkAndCountAi, getAiUsage } from '../config'

const CONFIG = join(SENTINEL_HOME, 'config.json')
function readUsage(): Record<string, { date: string; chat: number; ask: number; fix: number }> {
  return (JSON.parse(files.get(CONFIG) || '{}').aiUsage) || {}
}

describe('AI usage metering', () => {
  beforeEach(() => files.clear())

  it('host is unlimited and is never counted', () => {
    const r = checkAndCountAi(1, true, 'fix')
    expect(r.ok).toBe(true)
    expect(readUsage()['1']).toBeUndefined() // no write for host
  })

  it('counts per kind and blocks at the limit (fix default = 1)', () => {
    expect(checkAndCountAi(7, false, 'fix')).toEqual({ ok: true, remaining: 0 })
    expect(checkAndCountAi(7, false, 'fix').ok).toBe(false) // second fix same day → blocked
    // ask has its own independent counter (limit 20)
    expect(checkAndCountAi(7, false, 'ask').ok).toBe(true)
  })

  it('rolls counters when the stored day is stale', () => {
    checkAndCountAi(7, false, 'fix') // uses fix today
    // force the stored row to a past date
    const cfg = JSON.parse(files.get(CONFIG)!)
    cfg.aiUsage['7'].date = '2000-01-01'
    files.set(CONFIG, JSON.stringify(cfg))
    expect(checkAndCountAi(7, false, 'fix').ok).toBe(true) // new day → allowed again
  })

  it('getAiUsage reports used/limits; unlimited for host; no mutation', () => {
    checkAndCountAi(7, false, 'ask')
    const u = getAiUsage(7, false)
    expect(u.used.ask).toBe(1)
    expect(u.limits.fix).toBe(1)
    expect(u.unlimited).toBe(false)
    expect(getAiUsage(1, true).unlimited).toBe(true)
  })
})
