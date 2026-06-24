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
  mkdirSync: () => undefined,
  cpSync: () => undefined,
  rmSync: () => undefined
}))
vi.mock('../config', () => ({ getHostUid: () => 1000 }))

import { REGISTRY_PATH } from '../paths'
import { readRegistry, setBotOwner, botsOwnedBy } from '../registry'

describe('registry ownership', () => {
  beforeEach(() => files.clear())

  it('migrates unowned entries to the host uid (idempotent)', () => {
    files.set(REGISTRY_PATH, JSON.stringify([{ id: 'a', name: 'A', dirName: 'a' }]))
    expect(readRegistry()[0].ownerId).toBe(1000)
    const afterFirst = files.get(REGISTRY_PATH)
    readRegistry() // second read must NOT rewrite (already stamped)
    expect(files.get(REGISTRY_PATH)).toBe(afterFirst)
  })

  it('setBotOwner assigns ownership and botsOwnedBy filters by uid', () => {
    files.set(REGISTRY_PATH, JSON.stringify([
      { id: 'a', name: 'A', dirName: 'a', ownerId: 1000 },
      { id: 'b', name: 'B', dirName: 'b', ownerId: 1000 }
    ]))
    setBotOwner('b', 2000)
    expect(botsOwnedBy(2000).map((e) => e.id)).toEqual(['b'])
    expect(botsOwnedBy(1000).map((e) => e.id)).toEqual(['a'])
  })
})
