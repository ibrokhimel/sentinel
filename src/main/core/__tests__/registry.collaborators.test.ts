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
vi.mock('../config', () => ({ getHostUid: () => 1 }))

import { REGISTRY_PATH } from '../paths'
import { readRegistry, setCollaborator, removeCollaborator } from '../registry'

function seed(): void {
  files.set(REGISTRY_PATH, JSON.stringify([{ id: 'a', name: 'A', dirName: 'a', ownerId: 7 }]))
}

describe('registry collaborators', () => {
  beforeEach(() => { files.clear(); seed() })

  it('adds a collaborator with only known capability keys', () => {
    setCollaborator('a', 2, { viewLogs: true, editEnv: true, bogus: true } as never)
    const e = readRegistry().find((x) => x.id === 'a')!
    expect(e.collaborators!['2']).toEqual({ viewLogs: true, editEnv: true })
  })

  it('replaces an existing collaborator capability set', () => {
    setCollaborator('a', 2, { viewLogs: true })
    setCollaborator('a', 2, { startStop: true })
    expect(readRegistry().find((x) => x.id === 'a')!.collaborators!['2']).toEqual({ startStop: true })
  })

  it('removes a collaborator and prunes the empty map', () => {
    setCollaborator('a', 2, { viewLogs: true })
    removeCollaborator('a', 2)
    const e = readRegistry().find((x) => x.id === 'a')!
    expect(e.collaborators).toBeUndefined()
  })

  it('no-ops on an unknown bot', () => {
    expect(() => setCollaborator('nope', 2, { viewLogs: true })).not.toThrow()
    expect(() => removeCollaborator('nope', 2)).not.toThrow()
  })
})
