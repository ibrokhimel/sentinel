/**
 * Mini App AI chat routes — persistent multi-session chat that reuses the same
 * agent backend the desktop app uses. Session CRUD is plain JSON; /stream emits
 * a Server-Sent-Events feed so the phone UI can render tokens as they arrive.
 *
 * Two modes (v1):
 *   - 'chat' (Main): free-form streaming completion via chatStream.
 *   - 'ask'  (per-bot): read-only agent run (allowWrites:false) over a bot dir,
 *     surfacing the agent's text + tool activity as events.
 */
import * as sup from '../../supervisor'
import { getAgentConfig } from '../../config'
import { chatStream, type AgentProvider, type ChatMessage } from '../../agent/provider'
import { runAgent } from '../../agent/runtime'
import * as S from '../sessions'
import type { Route, RouteCtx } from './index'

function provider(): AgentProvider & { ready: boolean } {
  const a = getAgentConfig()
  return { baseUrl: a.baseUrl, apiKey: a.apiKey, model: a.model, ready: a.ready }
}

async function stream(c: RouteCtx): Promise<void> {
  const b = c.body as { id?: string; message?: string }
  const sess = b.id ? S.getSession(b.id) : S.getSession(S.MAIN_ID)
  const msg = String(b.message ?? '').trim()
  const res = c.res
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
  c.req.on('close', () => ac.abort())
  let finalText = ''
  try {
    const history: ChatMessage[] = sess.messages.map((m) => ({ role: m.role, content: m.content }))
    if (sess.mode === 'chat') {
      finalText = await chatStream(
        prov,
        [...history, { role: 'user', content: msg }],
        (full) => send({ type: 'delta', text: full }),
        ac.signal
      )
    } else {
      const bot = await sup.getBot(sess.botId as string)
      finalText = await runAgent({
        provider: prov,
        botId: bot.manifest.id,
        dir: bot.dir,
        task: msg,
        allowWrites: false,
        scope: 'bot',
        history,
        signal: ac.signal,
        events: {
          onText: (t) => send({ type: 'delta', text: t }),
          onTool: (name, args) => send({ type: 'tool', name, args }),
          onToolResult: (name, result) =>
            send({ type: 'tool_result', name, result: String(result).slice(0, 4000) })
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
    ownerOnly: true,
    handler: (c) => {
      const botId = c.url.searchParams.get('botId')
      c.json(200, { sessions: S.listSessions(botId === null ? undefined : botId) })
    }
  },
  {
    method: 'POST',
    path: '/api/chat/sessions',
    ownerOnly: true,
    handler: (c) => {
      const b = c.body as { botId?: string | null; mode?: string; title?: string }
      c.json(200, {
        session: S.createSession({ botId: b.botId ?? null, mode: b.mode === 'ask' ? 'ask' : 'chat', title: b.title })
      })
    }
  },
  {
    method: 'POST',
    path: '/api/chat/sessions/rename',
    ownerOnly: true,
    handler: (c) => {
      const b = c.body as { id?: string; title?: string }
      const s = S.renameSession(String(b.id), String(b.title || ''))
      c.json(s ? 200 : 404, s ? { session: s } : { error: 'not found' })
    }
  },
  {
    method: 'POST',
    path: '/api/chat/sessions/delete',
    ownerOnly: true,
    handler: (c) => {
      const ok = S.deleteSession(String((c.body as { id?: string }).id))
      c.json(ok ? 200 : 400, ok ? { ok: true } : { error: 'cannot delete' })
    }
  },
  {
    method: 'POST',
    path: '/api/chat/sessions/reset',
    ownerOnly: true,
    handler: (c) => {
      const s = S.resetSession(String((c.body as { id?: string }).id))
      c.json(s ? 200 : 404, s ? { session: s } : { error: 'not found' })
    }
  },
  { method: 'POST', path: '/api/chat/stream', ownerOnly: true, handler: stream }
]
