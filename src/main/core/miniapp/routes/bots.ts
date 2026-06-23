/**
 * bots.ts — Bot import / remove / upload routes
 *
 * All routes are ownerOnly: true.
 * Upload (POST /api/bots/upload) is a v1 stub returning 501 — multipart/raw-body
 * support requires a dedicated raw-body path in service.ts that does not exist yet.
 */
import * as sup from '../../supervisor'
import type { Route, RouteCtx } from './index'

async function importBot(c: RouteCtx): Promise<void> {
  const url = String((c.body as Record<string, unknown>).url ?? '').trim()
  if (!/^https?:\/\//.test(url)) {
    c.json(400, { error: 'provide a valid http(s) git URL' })
    return
  }
  try {
    const { bot } = await sup.importBot({ type: 'git', source: url })
    c.json(200, { ok: true, id: bot.manifest.id })
  } catch (e) {
    c.json(500, { error: String((e as Error)?.message ?? e) })
  }
}

async function removeBot(c: RouteCtx): Promise<void> {
  const b = c.body as { id?: string; confirm?: boolean }
  if (b.confirm !== true) {
    c.json(400, { error: 'confirm required' })
    return
  }
  try {
    await sup.removeBot(String(b.id))
    c.json(200, { ok: true })
  } catch (e) {
    c.json(500, { error: String((e as Error)?.message ?? e) })
  }
}

async function uploadBot(c: RouteCtx): Promise<void> {
  // v1 stub: multipart/raw-body needs a dedicated path in service.ts (not yet wired).
  // Wire when service.ts gains rawBody support for this route.
  c.json(501, { error: 'zip upload not yet supported — use Import from URL' })
}

export const botRoutes: Route[] = [
  { method: 'POST', path: '/api/bots/import', ownerOnly: true, handler: importBot },
  { method: 'POST', path: '/api/bots/remove', ownerOnly: true, handler: removeBot },
  { method: 'POST', path: '/api/bots/upload', ownerOnly: true, handler: uploadBot },
]
