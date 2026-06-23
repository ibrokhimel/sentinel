import { describe, it, expect, vi } from 'vitest'
import { safeResolve, redactEnv } from '../agent/tools'
import { extractJsonArray, runAgent, type RunAgentOpts } from '../agent/runtime'

// Spy on the provider so runAgent never hits the network in tests.
const chatCompletion = vi.fn()
vi.mock('../agent/provider', () => ({
  chatCompletion: (...args: unknown[]) => chatCompletion(...args)
}))

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

describe('runAgent abort signal', () => {
  const base: RunAgentOpts = {
    provider: { baseUrl: 'http://x', apiKey: 'k', model: 'm' },
    botId: 'b',
    dir: '/tmp/bot',
    task: 'do something',
    allowWrites: false
  }

  it('RunAgentOpts accepts an optional signal', () => {
    // Type-level guard: this object must compile.
    const opts: RunAgentOpts = { ...base, signal: new AbortController().signal }
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('halts the loop immediately when the signal is already aborted', async () => {
    chatCompletion.mockReset()
    const ac = new AbortController()
    ac.abort()
    const out = await runAgent({ ...base, signal: ac.signal })
    // No LLM call should have been made once aborted.
    expect(chatCompletion).not.toHaveBeenCalled()
    expect(typeof out).toBe('string')
  })

  it('threads the signal through to chatCompletion as the 4th arg', async () => {
    chatCompletion.mockReset()
    chatCompletion.mockResolvedValue({ role: 'assistant', content: 'final answer' })
    const ac = new AbortController()
    const out = await runAgent({ ...base, signal: ac.signal })
    expect(out).toBe('final answer')
    expect(chatCompletion).toHaveBeenCalledTimes(1)
    expect(chatCompletion.mock.calls[0][3]).toBe(ac.signal)
  })
})
