import { describe, it, expect, vi } from 'vitest'

vi.mock('../registry', () => ({
  readRegistry: () => [
    { id: 'a', name: 'A', dirName: 'a', ownerId: 7 },
    { id: 'b', name: 'B', dirName: 'b', ownerId: 1, collaborators: { '7': { viewLogs: true } } }
  ],
  findEntry: (id: string) =>
    ({
      a: { id: 'a', ownerId: 7 },
      b: { id: 'b', ownerId: 1, collaborators: { '7': { viewLogs: true } } }
    } as never)[id]
}))

import { filterOwned } from '../telegramBot'

const bots = [{ manifest: { id: 'a' } }, { manifest: { id: 'b' } }]

describe('control-bot visibility', () => {
  it('control bot shows a tenant only OWNED bots (not collaborated)', () => {
    expect(filterOwned(bots, 7, false).map((b) => b.manifest.id)).toEqual(['a'])
  })
  it('host sees all bots', () => {
    expect(filterOwned(bots, 1, true).map((b) => b.manifest.id).sort()).toEqual(['a', 'b'])
  })
})
