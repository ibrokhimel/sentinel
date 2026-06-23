/**
 * In-process Telegram Mini App for Sentinel itself — "the Sentinel GUI on your
 * phone". It runs INSIDE the same process as the inbound control bot
 * (telegramBot.ts), so it lives and dies with it (see index.ts).
 *
 * What it does, end to end:
 *  - serves a self-contained dashboard (frontend.ts) over a tiny node:http server
 *  - exposes a JSON API onto the SAME supervisor + config the desktop GUI uses
 *  - opens a cloudflared HTTPS tunnel so Telegram can load it
 *  - registers the control bot's chat menu button to the tunnel URL on every start
 *  - authorizes EVERY API call by verifying Telegram `initData` (HMAC over the
 *    bot token) and checking the user is the owner or an approved user
 *
 * No new dependencies: node:http + node:crypto + the cloudflared binary.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  getControlConfig,
  isUserApproved
} from '../config'
import { ROUTES, type RouteCtx } from './routes/index'
import { resolveBinSync } from '../node'
import { notifyOwner } from '../notify'
import { MINIAPP_HTML } from './frontend'

/** Local port the dashboard listens on. Picked to avoid the 3000/3001 range
 *  that managed Mini Apps default to. */
const PORT = Number(process.env.SENTINEL_MINIAPP_PORT) || 8787
/** Reject initData older than this (replay protection). */
const MAX_AUTH_AGE_SEC = 24 * 60 * 60
type AuthCtx = { userId: number; isOwner: boolean }

export class MiniAppService {
  private server: Server | null = null
  private tunnel: ChildProcess | null = null
  private url = ''
  private starting = false

  /** Start the server + tunnel if control is enabled and a token exists. Safe to
   *  call repeatedly; a no-op when already running or not configured. */
  start(): void {
    if (this.server || this.starting) return
    const cfg = getControlConfig()
    if (!cfg.enabled || !cfg.token) return
    this.starting = true
    try {
      this.server = createServer((req, res) => void this.handle(req, res))
      this.server.on('error', (e) => {
        console.error('[miniapp] server error:', e)
      })
      this.server.listen(PORT, '127.0.0.1', () => {
        console.log(`[miniapp] dashboard on http://127.0.0.1:${PORT}`)
        this.startTunnel(cfg.token)
      })
    } finally {
      this.starting = false
    }
  }

  /** Stop the tunnel + server. The menu button keeps its last URL until the next
   *  start re-registers it; that's harmless (it just won't load while stopped). */
  stop(): void {
    if (this.tunnel) {
      this.tunnel.kill()
      this.tunnel = null
    }
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.url = ''
  }

  /** Re-read config and (re)start or stop to match. Called after settings changes. */
  refresh(): void {
    const cfg = getControlConfig()
    if (cfg.enabled && cfg.token) {
      if (!this.server) this.start()
    } else {
      this.stop()
    }
  }

  // ---- tunnel + menu button ------------------------------------------------

  private startTunnel(token: string): void {
    const cf = resolveBinSync('cloudflared')
    if (!cf) {
      console.error('[miniapp] cloudflared not found — install with `brew install cloudflared`')
      void notifyOwner(
        '🛰️ Sentinel dashboard could not start its tunnel — cloudflared is not installed (`brew install cloudflared`).'
      )
      return
    }
    const child = spawn(cf, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.tunnel = child
    const onLine = (buf: Buffer): void => {
      const text = buf.toString()
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
      if (m && !this.url) {
        this.url = m[0]
        console.log(`[miniapp] tunnel up: ${this.url}`)
        void this.registerMenuButton(token, this.url)
      }
    }
    child.stdout?.on('data', onLine)
    child.stderr?.on('data', onLine) // cloudflared prints the URL on stderr
    child.on('exit', (code) => {
      console.log(`[miniapp] tunnel exited (${code})`)
      if (this.tunnel === child) this.tunnel = null
      this.url = ''
    })
  }

  private async registerMenuButton(token: string, url: string): Promise<void> {
    try {
      const body = {
        menu_button: { type: 'web_app', text: 'Sentinel', web_app: { url } }
      }
      const r = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      console.log(r.ok ? '[miniapp] menu button set' : `[miniapp] menu button failed (${r.status})`)
      if (r.ok) void notifyOwner(`🛰️ Sentinel dashboard is live — open it from the bot's menu button.`)
    } catch (e) {
      console.error('[miniapp] menu button error:', e)
    }
  }

  // ---- request handling ----------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
      const path = url.pathname

      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(MINIAPP_HTML)
        return
      }
      if (req.method === 'GET' && path === '/health') {
        return this.json(res, 200, { ok: true })
      }

      if (path.startsWith('/api/')) {
        const auth = this.authorize(req)
        if (!auth) return this.json(res, 401, { error: 'unauthorized — open this from your Sentinel bot' })
        return await this.api(path, req, res, auth, url)
      }

      res.writeHead(404)
      res.end('not found')
    } catch (e) {
      console.error('[miniapp] handler error:', e)
      this.json(res, 500, { error: String((e as Error)?.message ?? e) })
    }
  }

  /** Verify Telegram initData (header) and resolve the caller, or null. */
  private authorize(req: IncomingMessage): AuthCtx | null {
    const initData = (req.headers['x-tg-init-data'] as string) || ''
    const { token, ownerChatId } = getControlConfig()
    const v = verifyInitData(initData, token)
    if (!v.ok || !v.user) return null
    const userId = v.user.id
    const isOwner = ownerChatId.trim().length > 0 && String(userId) === ownerChatId.trim()
    if (isOwner || isUserApproved(userId)) return { userId, isOwner }
    return null
  }

  private async api(path: string, req: IncomingMessage, res: ServerResponse, auth: AuthCtx, url: URL): Promise<void> {
    let body: Record<string, unknown> = {}
    if (req.method === 'POST') {
      const text = await readBody(req)
      body = text ? JSON.parse(text) : {}
    }
    const route = ROUTES.find((r) => r.method === req.method && r.path === path)
    if (!route) return this.json(res, 404, { error: 'unknown endpoint' })
    if (route.ownerOnly && !auth.isOwner) return this.json(res, 403, { error: 'owner only' })
    const ctx: RouteCtx = { req, res, url, auth, body, json: (s, p) => this.json(res, s, p) }
    return await route.handler(ctx)
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }
}

// ---- initData verification (pure) -----------------------------------------

interface TgUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
}

/**
 * Validate Telegram WebApp initData per
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyInitData(
  initData: string,
  token: string
): { ok: boolean; user?: TgUser; reason?: string } {
  if (!initData) return { ok: false, reason: 'no initData' }
  if (!token) return { ok: false, reason: 'no token' }

  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return { ok: false, reason: 'no hash' }
  params.delete('hash')

  const dataCheckString = [...params.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const computed = createHmac('sha256', secret).update(dataCheckString).digest('hex')
  if (computed.length !== hash.length) return { ok: false, reason: 'bad signature' }
  if (!timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'))) {
    return { ok: false, reason: 'bad signature' }
  }

  const authDate = Number(params.get('auth_date')) || 0
  if (Math.floor(Date.now() / 1000) - authDate > MAX_AUTH_AGE_SEC) {
    return { ok: false, reason: 'expired' }
  }

  let user: TgUser | undefined
  try {
    user = JSON.parse(params.get('user') || 'null') ?? undefined
  } catch {
    /* no user */
  }
  if (!user) return { ok: false, reason: 'no user' }
  return { ok: true, user }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 256 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
