/**
 * collaborators.ts — per-bot collaborator management (owner/host of the bot only).
 * GET  /api/bots/collaborators?botId=  -> { collaborators, addable }
 * POST /api/bots/collaborators         { botId, userId, capabilities } -> { ok, ... }
 * POST /api/bots/collaborators/remove  { botId, userId } -> { ok, ... }
 */
import { findEntry, setCollaborator, removeCollaborator, type Capabilities } from '../../registry'
import { getApprovedProfiles, getApprovedUsers, getUserProfile, getHostUid } from '../../config'
import type { Route, RouteCtx } from './index'

const CAP_KEYS = ['viewLogs', 'chat', 'startStop', 'deploy', 'editEnv', 'viewSecrets'] as const

function cleanCaps(input: unknown): Capabilities {
  const out: Capabilities = {}
  const o = (input ?? {}) as Record<string, unknown>
  for (const k of CAP_KEYS) if (o[k] === true) out[k] = true
  return out
}

/** Owner-of-bot-or-host gate; returns the entry on success or null after sending 403/404. */
function ownerEntry(c: RouteCtx, botId: string): ReturnType<typeof findEntry> | null {
  const entry = findEntry(botId)
  if (!entry) { c.json(404, { error: 'no such bot' }); return null }
  if (!c.auth.isOwner && entry.ownerId !== c.auth.userId) { c.json(403, { error: 'only the bot owner can manage collaborators' }); return null }
  return entry
}

function snapshot(botId: string): { collaborators: Array<Capabilities & { id: number }>; addable: ReturnType<typeof getApprovedProfiles> } {
  const entry = findEntry(botId)
  const map = entry?.collaborators ?? {}
  const collaborators = Object.keys(map).map((uid) => {
    const p = getUserProfile(Number(uid))
    return { ...p, caps: map[uid] }
  }) as never
  const host = getHostUid()
  const existing = new Set(Object.keys(map).map(Number))
  const addable = getApprovedProfiles().filter(
    (p) => p.id !== host && p.id !== entry?.ownerId && !existing.has(p.id)
  )
  return { collaborators, addable }
}

function list(c: RouteCtx): void {
  const botId = c.url.searchParams.get('botId') ?? ''
  if (!ownerEntry(c, botId)) return
  c.json(200, snapshot(botId))
}

function add(c: RouteCtx): void {
  const b = c.body as { botId?: string; userId?: unknown; capabilities?: unknown }
  const botId = String(b.botId ?? '')
  const uid = Number(b.userId)
  if (!Number.isFinite(uid)) { c.json(400, { error: 'userId must be a finite number' }); return }
  if (!ownerEntry(c, botId)) return
  if (!getApprovedUsers().includes(uid)) { c.json(400, { error: 'user is not an approved tenant' }); return }
  setCollaborator(botId, uid, cleanCaps(b.capabilities))
  c.json(200, { ok: true, ...snapshot(botId) })
}

function remove(c: RouteCtx): void {
  const b = c.body as { botId?: string; userId?: unknown }
  const botId = String(b.botId ?? '')
  const uid = Number(b.userId)
  if (!Number.isFinite(uid)) { c.json(400, { error: 'userId must be a finite number' }); return }
  if (!ownerEntry(c, botId)) return
  removeCollaborator(botId, uid)
  c.json(200, { ok: true, ...snapshot(botId) })
}

export const collaboratorRoutes: Route[] = [
  { method: 'GET', path: '/api/bots/collaborators', ownerOnly: false, handler: list },
  { method: 'POST', path: '/api/bots/collaborators', ownerOnly: false, handler: add },
  { method: 'POST', path: '/api/bots/collaborators/remove', ownerOnly: false, handler: remove }
]
