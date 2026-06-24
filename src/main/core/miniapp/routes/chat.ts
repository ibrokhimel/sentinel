/**
 * Mini App AI chat routes — persistent multi-session chat that reuses the same
 * agent backend the desktop app uses. Session CRUD is plain JSON; /stream emits
 * a Server-Sent-Events feed so the phone UI can render tokens as they arrive.
 *
 * Two modes:
 *   - 'chat' (Main): a read-only FLEET agent run — answers cross-bot questions
 *     with specifics (list_bots / get_bot_status / read_bot_logs).
 *     Fleet scope enumerates ALL bots → host-only.
 *   - 'ask'  (per-bot): an agent run over one bot dir. The bot must be visible
 *     to the caller. Write access requires editEnv capability (owner/host only).
 */
import { randomUUID } from 'node:crypto'
import * as sup from '../../supervisor'
import { getAgentConfig, getAppConfig } from '../../config'
import { type AgentProvider, type ChatMessage } from '../../agent/provider'
import { runAgent } from '../../agent/runtime'
import { findEntry } from '../../registry'
import { can, assertCap } from '../authz'
import * as S from '../sessions'
import type { Route, RouteCtx } from './index'

function provider(): AgentProvider & { ready: boolean } {
  const a = getAgentConfig()
  return { baseUrl: a.baseUrl, apiKey: a.apiKey, model: a.model, ready: a.ready }
}

/**
 * Pending per-action confirmations, keyed by token. The agent loop awaits the
 * resolver while the phone is shown an Approve/Reject modal; POST /api/chat/confirm
 * (or client disconnect) settles it. Resolving false = "reject this action".
 * Bound to the creating user's uid to prevent cross-tenant token reuse.
 */
const pendingConfirms = new Map<string, { settle: (ok: boolean) => void; userId: number }>()

async function stream(c: RouteCtx): Promise<void> {
  const b = c.body as { id?: string; message?: string }
  const sessId = b.id || S.mainIdFor(c.auth.userId)
  const sess = S.getSessionFor(c.auth.userId, sessId)
  const msg = String(b.message ?? '').trim()
  const res = c.res

  // Visibility check for 'ask' sessions — do this BEFORE writing SSE headers so
  // a ForbiddenError propagates to 403 via service.ts cleanly.
  if (sess && sess.mode === 'ask' && sess.botId) {
    const entry = findEntry(String(sess.botId))
    if (!can(c.auth.userId, c.auth.isOwner, entry, 'view')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      const send = (o: unknown): boolean => res.write('data: ' + JSON.stringify(o) + '\n\n')
      send({ type: 'error', message: 'forbidden' })
      return void res.end()
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  const send = (o: unknown): boolean => res.write('data: ' + JSON.stringify(o) + '\n\n')
  if (!sess) {
    send({ type: 'error', message: 'no such session' })
    return void res.end()
  }
  const p = provider()
  if (!p.ready) {
    send({ type: 'error', message: 'AI not configured — set it in Settings.' })
    return void res.end()
  }
  if (!msg) {
    send({ type: 'error', message: 'empty message' })
    return void res.end()
  }
  const prov: AgentProvider = { baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model }
  const ac = new AbortController()
  // Tokens of confirmations issued for THIS request, so a client disconnect can
  // resolve them false (reject) and never hang the agent loop past the stream.
  const myTokens = new Set<string>()
  res.on('close', () => {
    // Abort only when the SSE response closes before we intentionally ended it.
    // IncomingMessage 'close' fires after the POST body is read even for healthy
    // requests; using it here aborted the provider fetch immediately and surfaced
    // to the Mini App as a bare "fetch failed".
    if (res.writableEnded) return
    ac.abort()
    for (const token of myTokens) {
      const entry = pendingConfirms.get(token)
      if (entry) {
        pendingConfirms.delete(token)
        entry.settle(false)
      }
    }
    myTokens.clear()
  })
  let finalText = ''
  try {
    const history: ChatMessage[] = sess.messages.map((m) => ({ role: m.role, content: m.content }))
    if (sess.mode === 'chat') {
      // Fleet scope enumerates ALL bots → host-only.
      if (!c.auth.isOwner) {
        send({ type: 'error', message: 'Fleet chat is host-only — open one of your bots to chat about it.' })
        return void res.end()
      }
      // Main session: read-only fleet operator — answers cross-bot questions
      // with specifics instead of a generic refusal.
      send({ type: 'mode', allowWrites: false })
      finalText = await runAgent({
        provider: prov,
        botId: '',
        dir: '',
        task: msg,
        allowWrites: false,
        scope: 'fleet',
        history,
        signal: ac.signal,
        events: { onText: (t) => send({ type: 'delta', text: t }) }
      })
    } else {
      const bot = await sup.getBot(sess.botId as string)
      // Gating for the per-bot manager:
      //   no editEnv cap        → read-only (allowWrites:false).
      //   editEnv cap + YOLO    → allowWrites:true, no confirm handler → acts now.
      //   editEnv cap + !YOLO   → allowWrites:true WITH a per-action confirm that
      //                           asks the phone before each mutating tool runs.
      const entry = findEntry(String(sess.botId))
      const allowWrites = can(c.auth.userId, c.auth.isOwner, entry, 'editEnv')
      const yolo = getAppConfig().autoApprove
      send({ type: 'mode', allowWrites })
      const confirm =
        allowWrites && !yolo
          ? (summary: string): Promise<boolean> =>
              new Promise<boolean>((resolve) => {
                const token = randomUUID()
                myTokens.add(token)
                let settled = false
                const settle = (ok: boolean): void => {
                  if (settled) return
                  settled = true
                  clearTimeout(timer)
                  pendingConfirms.delete(token)
                  myTokens.delete(token)
                  resolve(ok)
                }
                // Safety net: never let a forgotten prompt block the loop forever.
                const timer = setTimeout(() => settle(false), 120_000)
                pendingConfirms.set(token, { settle, userId: c.auth.userId })
                send({ type: 'confirm', token, summary })
              })
          : undefined
      finalText = await runAgent({
        provider: prov,
        botId: bot.manifest.id,
        dir: bot.dir,
        task: msg,
        allowWrites,
        scope: 'bot',
        history,
        signal: ac.signal,
        events: {
          onText: (t) => send({ type: 'delta', text: t }),
          onTool: (name, args) => send({ type: 'tool', name, args }),
          onToolResult: (name, result) =>
            send({ type: 'tool_result', name, result: String(result).slice(0, 4000) }),
          ...(confirm ? { confirm } : {})
        }
      })
    }
    S.appendTurn(sess.id, msg, finalText)
    send({ type: 'done', content: finalText })
  } catch (e) {
    send({ type: 'error', message: String((e as Error)?.message ?? e) })
  }
  res.end()
}

export const chatRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/chat/sessions',
    ownerOnly: false,
    handler: (c) => {
      const botId = c.url.searchParams.get('botId')
      c.json(200, { sessions: S.listSessions(c.auth.userId, botId === null ? undefined : botId) })
    }
  },
  {
    method: 'POST',
    path: '/api/chat/sessions',
    ownerOnly: false,
    handler: (c) => {
      const b = c.body as { botId?: string | null; mode?: string; title?: string }
      const mode = b.mode === 'ask' ? 'ask' : 'chat'
      // If creating an 'ask' session for a specific bot, verify caller can see it.
      if (mode === 'ask' && b.botId) {
        assertCap(c.auth.userId, c.auth.isOwner, String(b.botId), 'view')
      }
      c.json(200, {
        session: S.createSession({
          ownerId: c.auth.userId,
          botId: b.botId ?? null,
          mode,
          title: b.title
        })
      })
    }
  },
  {
    method: 'POST',
    path: '/api/chat/sessions/rename',
    ownerOnly: false,
    handler: (c) => {
      const b = c.body as { id?: string; title?: string }
      const owned = S.getSessionFor(c.auth.userId, String(b.id))
      if (!owned) return c.json(404, { error: 'not found' })
      const s = S.renameSession(owned.id, String(b.title || ''))
      c.json(s ? 200 : 404, s ? { session: s } : { error: 'not found' })
    }
  },
  {
    method: 'POST',
    path: '/api/chat/sessions/delete',
    ownerOnly: false,
    handler: (c) => {
      const owned = S.getSessionFor(c.auth.userId, String((c.body as { id?: string }).id))
      if (!owned) return c.json(404, { error: 'not found' })
      const ok = S.deleteSession(owned.id)
      c.json(ok ? 200 : 400, ok ? { ok: true } : { error: 'cannot delete' })
    }
  },
  {
    method: 'POST',
    path: '/api/chat/sessions/reset',
    ownerOnly: false,
    handler: (c) => {
      const owned = S.getSessionFor(c.auth.userId, String((c.body as { id?: string }).id))
      if (!owned) return c.json(404, { error: 'not found' })
      const s = S.resetSession(owned.id)
      c.json(s ? 200 : 404, s ? { session: s } : { error: 'not found' })
    }
  },
  { method: 'POST', path: '/api/chat/stream', ownerOnly: false, handler: stream },
  {
    method: 'POST',
    path: '/api/chat/confirm',
    ownerOnly: false,
    handler: (c) => {
      const b = c.body as { token?: string; approve?: boolean }
      const token = String(b.token ?? '')
      const entry = pendingConfirms.get(token)
      if (!entry || entry.userId !== c.auth.userId) return c.json(404, { error: 'unknown or expired token' })
      pendingConfirms.delete(token)
      entry.settle(!!b.approve)
      c.json(200, { ok: true })
    }
  }
]
