import { describe, it, expect, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

beforeEach(() => {
  process.env.SENTINEL_DATA_HOME = mkdtempSync(join(tmpdir(), 'sent-'))
})

describe('sessions store', () => {
  it('always has a non-deletable Main session', async () => {
    const s = await import('../miniapp/sessions')
    const main = s.getSession(s.MAIN_ID)
    expect(main?.botId).toBe(null)
    expect(main?.mode).toBe('chat')
    expect(s.deleteSession(s.MAIN_ID)).toBe(false)
  })
  it('creates, lists by bot, renames, resets, appends with caps', async () => {
    const s = await import('../miniapp/sessions')
    const a = s.createSession({ botId: 'bot1', mode: 'ask', title: 'Investigate' })
    expect(s.listSessions('bot1').map((x) => x.id)).toContain(a.id)
    expect(s.renameSession(a.id, 'Renamed')?.title).toBe('Renamed')
    for (let i = 0; i < 40; i++) s.appendTurn(a.id, 'u' + i, 'a' + i)
    expect(s.getSession(a.id)!.messages.length).toBeLessThanOrEqual(32)
    expect(s.resetSession(a.id)?.messages.length).toBe(0)
    expect(s.deleteSession(a.id)).toBe(true)
  })
})
