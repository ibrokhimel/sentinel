import { describe, it, expect, vi } from 'vitest'

vi.mock('../registry', () => ({
  readRegistry: () => [
    { id: 'a', name: 'A', dirName: 'a', ownerId: 7 },
    { id: 'b', name: 'B', dirName: 'b', ownerId: 1 }
  ],
  findEntry: (id: string) =>
    ({ a: { id: 'a', ownerId: 7 }, b: { id: 'b', ownerId: 1 } } as never)[id]
}))

import { filterVisible } from '../telegramBot'

const bots = [{ manifest: { id: 'a' } }, { manifest: { id: 'b' } }]

describe('control-bot visibility', () => {
  it('tenant sees only their bot', () => {
    expect(filterVisible(bots, 7, false).map((b) => b.manifest.id)).toEqual(['a'])
  })
  it('host sees all', () => {
    expect(filterVisible(bots, 1, true).map((b) => b.manifest.id).sort()).toEqual(['a', 'b'])
  })
})
