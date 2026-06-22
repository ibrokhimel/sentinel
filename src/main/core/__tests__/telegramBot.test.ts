import { describe, it, expect } from 'vitest'
import {
  isAuthorized,
  parseCommand,
  resolveBot,
  statusEmoji,
  formatFleet,
  escapeHtml,
  maskSecret,
  gitUrlFrom
} from '../telegramBot'
import type { Bot, BotStatus } from '@shared/types'

function bot(id: string, name: string, status: BotStatus, extra: Partial<Bot['runtime']> = {}): Bot {
  return {
    manifest: {
      id,
      name,
      source: { type: 'local', origin: '/x' },
      packageManager: 'venv',
      python: '.venv/bin/python',
      entry: ['run.py'],
      envFile: '.env',
      envKeys: [],
      restartPolicy: 'always',
      maxRestarts: 10,
      autostart: true,
      createdAt: '2026-01-01T00:00:00Z'
    },
    dir: `/bots/${id}`,
    runtime: {
      label: `com.sentinel.${id}`,
      status,
      pid: status === 'running' ? 1234 : null,
      lastExitCode: status === 'crashed' ? 1 : null,
      restarts: 0,
      installed: true,
      envReady: true,
      envFilePresent: true,
      ...extra
    }
  }
}

describe('isAuthorized', () => {
  it('only matches the configured owner chat id', () => {
    expect(isAuthorized(42, '42')).toBe(true)
    expect(isAuthorized('42', '42')).toBe(true)
    expect(isAuthorized(43, '42')).toBe(false)
  })
  it('denies everyone when no owner is set', () => {
    expect(isAuthorized(42, '')).toBe(false)
    expect(isAuthorized(42, '   ')).toBe(false)
  })
})

describe('parseCommand', () => {
  it('splits command and argument, lowercases, strips @botname', () => {
    expect(parseCommand('/status')).toEqual({ cmd: '/status', arg: '' })
    expect(parseCommand('/Logs  WatcherDog ')).toEqual({ cmd: '/logs', arg: 'WatcherDog' })
    expect(parseCommand('/update@SentinelBot my bot')).toEqual({ cmd: '/update', arg: 'my bot' })
  })
})

describe('resolveBot', () => {
  const bots = [bot('ab12', 'WatcherDog', 'running'), bot('cd34', 'telegram-mcp', 'stopped')]
  it('matches by exact id, id prefix, exact and partial name', () => {
    expect(resolveBot(bots, 'ab12')?.manifest.id).toBe('ab12')
    expect(resolveBot(bots, 'cd')?.manifest.id).toBe('cd34')
    expect(resolveBot(bots, 'watcherdog')?.manifest.id).toBe('ab12')
    expect(resolveBot(bots, 'mcp')?.manifest.id).toBe('cd34')
  })
  it('returns null for no match or empty query', () => {
    expect(resolveBot(bots, 'zzz')).toBeNull()
    expect(resolveBot(bots, '')).toBeNull()
  })
})

describe('formatting', () => {
  it('maps statuses to emoji', () => {
    expect(statusEmoji('running')).toBe('🟢')
    expect(statusEmoji('crashed')).toBe('🔴')
    expect(statusEmoji('crash-looping')).toBe('🔴')
    expect(statusEmoji('scheduled')).toBe('🟡')
    expect(statusEmoji('stopped')).toBe('⚪️')
  })

  it('summarizes the fleet with a running count and per-bot lines', () => {
    const out = formatFleet([bot('a', 'Alpha', 'running'), bot('b', 'Beta', 'crashed')])
    expect(out).toContain('1/2 running')
    expect(out).toContain('1 down')
    expect(out).toContain('Alpha')
    expect(out).toContain('exit 1')
  })

  it('handles an empty fleet', () => {
    expect(formatFleet([])).toContain('No bots')
  })

  it('escapes HTML in bot names', () => {
    expect(escapeHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c')
    expect(formatFleet([bot('a', 'Ev<il>', 'running')])).toContain('Ev&lt;il&gt;')
  })
})

describe('gitUrlFrom', () => {
  it('normalizes bare repo links to https clone URLs', () => {
    expect(gitUrlFrom('https://github.com/owner/repo')).toBe('https://github.com/owner/repo')
    expect(gitUrlFrom('github.com/owner/repo')).toBe('https://github.com/owner/repo')
    expect(gitUrlFrom('https://github.com/owner/repo.git')).toBe('https://github.com/owner/repo')
    expect(gitUrlFrom('  https://gitlab.com/o/r/  ')).toBe('https://gitlab.com/o/r')
  })
  it('ignores non-repo text and mid-sentence URLs', () => {
    expect(gitUrlFrom('what is https://github.com/owner/repo')).toBeNull()
    expect(gitUrlFrom('hello there')).toBeNull()
    expect(gitUrlFrom('git@github.com:owner/repo.git')).toBeNull()
  })
})

describe('maskSecret', () => {
  it('never reveals the value, only its length', () => {
    const secret = '8675756150:AAHXj83-IWWUa48hdFaz'
    const masked = maskSecret(secret)
    expect(masked).not.toContain('AAHXj83')
    expect(masked).not.toContain('8675756150')
    expect(masked).toBe(`•••• (${secret.length} chars)`)
  })
})
