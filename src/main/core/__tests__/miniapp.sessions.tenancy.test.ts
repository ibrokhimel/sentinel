import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

beforeEach(() => {
  process.env.SENTINEL_DATA_HOME = mkdtempSync(join(tmpdir(), 'sent-sess-'))
})

import { createSession, listSessions, getSessionFor, mainIdFor } from '../miniapp/sessions'

describe('session tenancy', () => {
  it('scopes sessions to their owner', () => {
    const s7 = createSession({ ownerId: 7, botId: 'a', mode: 'ask', title: 't7' })
    createSession({ ownerId: 8, botId: 'b', mode: 'ask', title: 't8' })
    expect(listSessions(7).map((s) => s.title)).toContain('t7')
    expect(listSessions(7).map((s) => s.title)).not.toContain('t8')
    expect(getSessionFor(8, s7.id)).toBeNull() // cannot read another tenant's session
    expect(getSessionFor(7, s7.id)?.title).toBe('t7')
  })
  it('gives each tenant a distinct main id', () => {
    expect(mainIdFor(7)).not.toBe(mainIdFor(8))
  })
})
