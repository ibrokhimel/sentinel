import { describe, it, expect } from 'vitest'
import { can, ForbiddenError, assertCap } from '../miniapp/authz'
import type { RegistryEntry } from '../registry'

const owned = (uid: number): RegistryEntry => ({ id: 'b', name: 'B', dirName: 'b', ownerId: uid })
const withCollab = (caps: Record<string, boolean>): RegistryEntry => ({
  id: 'b', name: 'B', dirName: 'b', ownerId: 1, collaborators: { '2': caps as never }
})

describe('can() truth table', () => {
  it('host can do everything, even on an unknown bot', () => {
    expect(can(999, true, undefined, 'editEnv')).toBe(true)
    expect(can(999, true, owned(1), 'viewSecrets')).toBe(true)
  })
  it('owner can do everything on their bot', () => {
    expect(can(1, false, owned(1), 'editEnv')).toBe(true)
    expect(can(1, false, owned(1), 'viewSecrets')).toBe(true)
  })
  it('stranger is denied all, including view', () => {
    for (const cap of ['view', 'viewLogs', 'chat', 'startStop', 'deploy', 'editEnv', 'viewSecrets'] as const) {
      expect(can(3, false, owned(1), cap)).toBe(false)
    }
  })
  it('collaborator: view always allowed; other caps follow the toggle', () => {
    expect(can(2, false, withCollab({ viewLogs: true }), 'view')).toBe(true)
    expect(can(2, false, withCollab({ viewLogs: true }), 'viewLogs')).toBe(true)
    expect(can(2, false, withCollab({ viewLogs: true }), 'editEnv')).toBe(false)
  })
  it('collaborator can never remove/manage (no such cap grants it)', () => {
    // remove is gated at the route as owner/host-only; collaborators have no editEnv by default
    expect(can(2, false, withCollab({}), 'editEnv')).toBe(false)
  })
  it('unknown bot for non-host is denied', () => {
    expect(can(2, false, undefined, 'view')).toBe(false)
  })
})

describe('assertCap', () => {
  it('throws ForbiddenError for a denied capability', () => {
    expect(() => assertCap(3, false, 'nope', 'view')).toThrow(ForbiddenError)
  })
})
