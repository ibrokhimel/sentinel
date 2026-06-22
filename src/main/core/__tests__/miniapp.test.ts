import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detect } from '../detect'
import { resolveArgv } from '../launchspec'
import { buildMiniAppWrapper, MINIAPP_WRAPPER, type WrapperSpec } from '../node'
import type { BotManifest } from '@shared/types'

const dirs: string[] = []
function project(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'sentinel-miniapp-'))
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

const pkg = (o: unknown): string => JSON.stringify(o)

describe('detect Node / Mini App', () => {
  it('detects a Vite app as a Mini App on port 5173', () => {
    const d = project({
      'package.json': pkg({
        scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        devDependencies: { vite: '^5' }
      })
    })
    const r = detect(d)
    expect(r.runtime).toBe('node')
    expect(r.packageManager).toBe('npm')
    expect(r.entry).toEqual(['__miniapp__'])
    expect(r.miniApp).toEqual({ script: 'dev', port: 5173, webFramework: 'vite' })
  })

  it('detects Next.js on port 3000 and picks the package manager from the lockfile', () => {
    const d = project({
      'package.json': pkg({ scripts: { start: 'next start', dev: 'next dev' }, dependencies: { next: '^14' } }),
      'pnpm-lock.yaml': ''
    })
    const r = detect(d)
    expect(r.packageManager).toBe('pnpm')
    expect(r.miniApp).toEqual({ script: 'start', port: 3000, webFramework: 'next' })
  })

  it('treats an Express server with a start script as a Mini App (framework node)', () => {
    const d = project({
      'package.json': pkg({ scripts: { start: 'node server.js' }, dependencies: { express: '^4' } })
    })
    const r = detect(d)
    expect(r.miniApp).toEqual({ script: 'start', port: 3000, webFramework: 'node' })
    expect(r.entry).toEqual(['__miniapp__'])
  })

  it('treats a Telegraf bot (no web framework) as a plain Node bot, not a Mini App', () => {
    const d = project({
      'package.json': pkg({ scripts: { start: 'node bot.js' }, dependencies: { telegraf: '^4' } })
    })
    const r = detect(d)
    expect(r.runtime).toBe('node')
    expect(r.miniApp).toBeUndefined()
    expect(r.entry).toEqual(['__npm__:start'])
  })

  it('reads env keys from .env.example for Node projects', () => {
    const d = project({
      'package.json': pkg({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }),
      '.env.example': 'TELEGRAM_BOT_TOKEN=\nAPI_BASE=\n'
    })
    expect(detect(d).envKeys).toEqual(['TELEGRAM_BOT_TOKEN', 'API_BASE'])
  })
})

describe('resolveArgv for Node runtime', () => {
  const mk = (entry: string[], extra: Partial<BotManifest> = {}): BotManifest => ({
    id: 'x',
    name: 'x',
    source: { type: 'local', origin: '/tmp/x' },
    runtime: 'node',
    packageManager: 'npm',
    python: '',
    entry,
    envFile: '.env',
    envKeys: [],
    restartPolicy: 'always',
    maxRestarts: 10,
    autostart: true,
    createdAt: '',
    ...extra
  })

  it('runs the Mini App wrapper via bash', () => {
    expect(resolveArgv(mk(['__miniapp__']), '/bots/app')).toEqual([
      '/bin/bash',
      join('/bots/app', MINIAPP_WRAPPER)
    ])
  })

  it('runs an npm script for a plain Node bot', () => {
    const argv = resolveArgv(mk(['__npm__:start']), '/bots/bot')
    expect(argv.slice(-2)).toEqual(['run', 'start'])
  })
})

describe('buildMiniAppWrapper', () => {
  const base: WrapperSpec = {
    dir: '/bots/app',
    pm: 'npm',
    binDir: '/opt/homebrew/bin',
    script: 'dev',
    port: 5173,
    webFramework: 'vite',
    tunnel: 'cloudflared',
    cloudflaredPath: '/opt/homebrew/bin/cloudflared',
    setMenuButton: true,
    menuText: 'Open App'
  }

  it('starts a cloudflared tunnel and registers the menu button from the trycloudflare URL', () => {
    const sh = buildMiniAppWrapper(base)
    expect(sh).toContain('/opt/homebrew/bin/cloudflared')
    expect(sh).toContain('tunnel --no-autoupdate --url "http://localhost:$PORT"')
    expect(sh).toContain('trycloudflare')
    expect(sh).toContain('setChatMenuButton')
    expect(sh).toContain('register_menu')
    // vite gets an explicit --port flag
    expect(sh).toContain('"npm" run "dev" -- --port "$PORT" --host')
    // default port fallback
    expect(sh).toContain('PORT="${PORT:-5173}"')
  })

  it('registers a fixed public URL and waits when tunnel is "none"', () => {
    const sh = buildMiniAppWrapper({
      ...base,
      tunnel: 'none',
      publicUrl: 'https://app.example.com',
      webFramework: 'node'
    })
    expect(sh).toContain('register_menu "https://app.example.com"')
    expect(sh).toContain('wait "$SERVER_PID"')
    expect(sh).not.toContain('cloudflared')
    // non-vite frameworks rely on the exported PORT, no --port flag
    expect(sh).toContain('"npm" run "dev"')
    expect(sh).not.toContain('--port "$PORT" --host')
  })

  it('omits menu-button registration when setMenuButton is false', () => {
    const sh = buildMiniAppWrapper({ ...base, setMenuButton: false })
    expect(sh).not.toContain('register_menu')
    expect(sh).not.toContain('setChatMenuButton')
  })
})
