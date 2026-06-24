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

import { getHostUid, getLimits, setLimits, setNotifyConfig } from '../config'

describe('tenancy config', () => {
  beforeEach(() => files.clear())

  it('derives host uid from the control owner chat id', () => {
    expect(getHostUid()).toBeNull() // unset
    setNotifyConfig({ chatId: '8683512953' })
    expect(getHostUid()).toBe(8683512953)
  })

  it('returns default limits and persists overrides across reads', () => {
    expect(getLimits().maxBotsPerTenant).toBe(5)
    setLimits({ maxBotsPerTenant: 9 })
    expect(getLimits().maxBotsPerTenant).toBe(9) // survives readStored round-trip
    expect(getLimits().aiPerDay.fix).toBe(1)
  })
})
