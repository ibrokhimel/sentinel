/**
 * users.ts — User approval management routes
 *
 * All routes are ownerOnly: true.
 * GET  /api/users          → { approved: number[] }
 * POST /api/users/approve  { userId } → { ok: true, approved: number[] }
 * POST /api/users/revoke   { userId } → { ok: true, approved: number[] }
 *
 * Pending requests are approved from the bot (/approve command); this API
 * only manages the approved-users list (no queryable pending queue exists).
 */
import { getApprovedUsers, approveUser, rejectUser } from '../../config'
import type { Route, RouteCtx } from './index'

function parseUserId(body: Record<string, unknown>): number | null {
  const raw = body.userId
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function listUsers(c: RouteCtx): void {
  c.json(200, { approved: getApprovedUsers() })
}

function approve(c: RouteCtx): void {
  const id = parseUserId(c.body)
  if (id === null) {
    c.json(400, { error: 'userId must be a finite number' })
    return
  }
  approveUser(id)
  c.json(200, { ok: true, approved: getApprovedUsers() })
}

function revoke(c: RouteCtx): void {
  const id = parseUserId(c.body)
  if (id === null) {
    c.json(400, { error: 'userId must be a finite number' })
    return
  }
  rejectUser(id)
  c.json(200, { ok: true, approved: getApprovedUsers() })
}

export const userRoutes: Route[] = [
  { method: 'GET',  path: '/api/users',         ownerOnly: true, handler: listUsers },
  { method: 'POST', path: '/api/users/approve',  ownerOnly: true, handler: approve },
  { method: 'POST', path: '/api/users/revoke',   ownerOnly: true, handler: revoke },
]
