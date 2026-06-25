import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory filesystem so the config round-trip is exercised without touching
// the real ~/Documents/Sentinel/config.json.
const files = new Map<string, string>()

vi.mock('node:fs', () => ({
  existsSync: (p: string) => files.has(p),
  readFileSync: (p: string) => {
    const v = files.get(p)
    if (v === undefined) throw new Error('ENOENT: ' + p)
    return v
  },
  writeFileSync: (p: string, data: string) => {
    files.set(p, data)
  },
  mkdirSync: () => undefined
}))

import {
  approveUser,
  isUserApproved,
  addPendingRequest,
  getPendingRequests,
  getApprovedProfiles
} from '../config'

describe('access-control persistence (config.json round-trip)', () => {
  beforeEach(() => files.clear())

  it('keeps a user approved across subsequent reads', () => {
    approveUser(12345)
    // Reads after the write must still see the approval (regression: readStored
    // used to discard approvedUsers, so this came back false).
    expect(isUserApproved(12345)).toBe(true)
  })

  it('does not re-queue an already-approved user on /start', () => {
    approveUser(999)
    // A later /start calls addPendingRequest, which no-ops when already approved.
    addPendingRequest({ id: 999, firstName: 'Ada' })
    expect(getPendingRequests().some((p) => p.id === 999)).toBe(false)
    expect(isUserApproved(999)).toBe(true)
  })

  it('preserves approval after an unrelated pending request is written', () => {
    approveUser(111)
    addPendingRequest({ id: 222, firstName: 'Bob' }) // triggers another writeStored
    expect(isUserApproved(111)).toBe(true)
    expect(getApprovedProfiles().some((p) => p.id === 111)).toBe(true)
  })
})
