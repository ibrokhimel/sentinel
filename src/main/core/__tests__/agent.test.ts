import { describe, it, expect } from 'vitest'
import { safeResolve, redactEnv } from '../agent/tools'
import { extractJsonArray } from '../agent/runtime'

describe('safeResolve', () => {
  const dir = '/bots/watcherdog'
  it('resolves paths inside the bot dir', () => {
    expect(safeResolve(dir, 'run.py')).toBe('/bots/watcherdog/run.py')
    expect(safeResolve(dir, 'sub/a.py')).toBe('/bots/watcherdog/sub/a.py')
    expect(safeResolve(dir, '.')).toBe('/bots/watcherdog')
  })
  it('rejects path traversal escapes', () => {
    expect(() => safeResolve(dir, '../secrets')).toThrow(/escapes/)
    expect(() => safeResolve(dir, '../../etc/passwd')).toThrow(/escapes/)
    expect(() => safeResolve(dir, '/etc/passwd')).toThrow(/escapes/)
  })
})

describe('redactEnv', () => {
  it('hides values but keeps key names and comments', () => {
    const out = redactEnv('# comment\nBOT_TOKEN=12345:secret\nEMPTY=\nAPI_ID=999')
    expect(out).toContain('# comment')
    expect(out).toContain('BOT_TOKEN=<set, hidden>')
    expect(out).toContain('API_ID=<set, hidden>')
    expect(out).toContain('EMPTY=')
    expect(out).not.toContain('12345:secret')
    expect(out).not.toContain('999')
  })
})

describe('extractJsonArray', () => {
  it('pulls a JSON array out of chatty text', () => {
    const text = 'Here you go:\n[{"key":"A","description":"x","secret":true}]\nHope that helps!'
    const arr = extractJsonArray(text) as Array<Record<string, unknown>>
    expect(arr).toHaveLength(1)
    expect(arr[0].key).toBe('A')
  })
  it('returns [] when there is no array', () => {
    expect(extractJsonArray('no json here')).toEqual([])
    expect(extractJsonArray('')).toEqual([])
  })
})
