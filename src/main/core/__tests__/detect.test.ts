import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detect } from '../detect'
import { resolveArgv } from '../launchspec'
import type { BotManifest } from '@shared/types'

const dirs: string[] = []
function project(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'sentinel-detect-'))
  dirs.push(d)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(d, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('detect package manager', () => {
  it('detects uv from uv.lock', () => {
    const d = project({ 'uv.lock': '', 'main.py': '' })
    expect(detect(d).packageManager).toBe('uv')
  })
  it('detects poetry from poetry.lock', () => {
    const d = project({ 'poetry.lock': '', 'main.py': '' })
    expect(detect(d).packageManager).toBe('poetry')
  })
  it('detects pipenv from Pipfile', () => {
    const d = project({ Pipfile: '', 'main.py': '' })
    expect(detect(d).packageManager).toBe('pipenv')
  })
  it('defaults to venv for requirements.txt', () => {
    const d = project({ 'requirements.txt': 'telethon', 'run.py': '' })
    expect(detect(d).packageManager).toBe('venv')
  })
  it('detects an existing .venv', () => {
    const d = project({ '.venv/bin/python': '#!/bin/sh\n', 'main.py': '' })
    expect(detect(d).packageManager).toBe('existing')
  })
})

describe('detect entry point', () => {
  it('prefers main.py convention', () => {
    const d = project({ 'main.py': '', 'run.py': '' })
    expect(detect(d).entry).toEqual(['main.py'])
  })
  it('falls back to run.py when no main.py', () => {
    const d = project({ 'run.py': '' })
    expect(detect(d).entry).toEqual(['run.py'])
  })
  it('parses a Procfile worker line', () => {
    const d = project({ Procfile: 'worker: python bot.py --prod\n' })
    expect(detect(d).entry).toEqual(['bot.py', '--prod'])
  })
  it('detects [project.scripts] console script', () => {
    const d = project({
      'pyproject.toml': '[project.scripts]\nmybot = "pkg.cli:main"\n'
    })
    expect(detect(d).entry).toEqual(['__script__:mybot'])
  })
  it('detects a package with __main__.py', () => {
    const d = project({ 'mypkg/__main__.py': '', 'mypkg/__init__.py': '' })
    expect(detect(d).entry).toEqual(['-m', 'mypkg'])
  })
  it('reports low confidence when nothing matches', () => {
    const d = project({ 'README.md': 'hi' })
    expect(detect(d).confidence).toBe('low')
    expect(detect(d).entry).toEqual([])
  })
})

describe('detect env keys', () => {
  it('reads keys from .env.example', () => {
    const d = project({ '.env.example': 'API_ID=1\nAPI_HASH=2\n', 'main.py': '' })
    expect(detect(d).envKeys).toEqual(['API_ID', 'API_HASH'])
  })
})

describe('detect framework', () => {
  it('detects telethon from requirements', () => {
    const d = project({ 'requirements.txt': 'telethon>=1.36\n', 'main.py': '' })
    expect(detect(d).framework).toBe('telethon')
  })
  it('detects aiogram', () => {
    const d = project({ 'requirements.txt': 'aiogram==3.1\n', 'bot.py': '' })
    expect(detect(d).framework).toBe('aiogram')
  })
  it('detects pyrogram', () => {
    const d = project({ 'pyproject.toml': '[project]\ndependencies=["pyrogram"]\n', 'main.py': '' })
    expect(detect(d).framework).toBe('pyrogram')
  })
  it('detects bot-api (python-telegram-bot)', () => {
    const d = project({ 'requirements.txt': 'python-telegram-bot==21\n', 'main.py': '' })
    expect(detect(d).framework).toBe('bot-api')
  })
  it('detects from source imports when deps are silent', () => {
    const d = project({ 'main.py': 'from telethon import TelegramClient\n' })
    expect(detect(d).framework).toBe('telethon')
  })
  it('returns unknown when nothing matches', () => {
    const d = project({ 'main.py': 'print(1)\n' })
    expect(detect(d).framework).toBe('unknown')
  })
})

describe('resolveArgv', () => {
  const mk = (entry: string[], python = '.venv/bin/python'): BotManifest => ({
    id: 'x',
    name: 'x',
    source: { type: 'local', origin: '/tmp/x' },
    packageManager: 'venv',
    python,
    entry,
    envFile: '.env',
    envKeys: [],
    restartPolicy: 'always',
    maxRestarts: 10,
    autostart: true,
    createdAt: ''
  })

  it('prefixes interpreter for a script entry', () => {
    expect(resolveArgv(mk(['run.py', '--x']), '/bots/wd')).toEqual([
      '/bots/wd/.venv/bin/python',
      'run.py',
      '--x'
    ])
  })
  it('runs a console script directly without python', () => {
    expect(resolveArgv(mk(['__script__:mybot']), '/bots/wd')).toEqual(['/bots/wd/.venv/bin/mybot'])
  })
  it('respects an absolute interpreter path', () => {
    expect(resolveArgv(mk(['main.py'], '/abs/python'), '/bots/wd')).toEqual(['/abs/python', 'main.py'])
  })
})
