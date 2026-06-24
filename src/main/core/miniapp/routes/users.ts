/**
 * users.ts — User approval management routes
 *
 * All routes are ownerOnly: true.
 * GET  /api/users          → { approved: UserProfile[], pending: UserProfile[] }
 * POST /api/users/approve  { userId } → { ok, approved, pending }   (pending → approved)
 * POST /api/users/reject   { userId } → { ok, approved, pending }   (drop a pending request)
 * POST /api/users/revoke   { userId } → { ok, approved, pending }   (remove an approved user)
 *
 * Identity (name / @handle) is captured by the bot at request time, so a request
 * raised via Telegram /start is visible and actionable here too (parity).
 */
import {
  getApprovedProfiles,
  getPendingRequests,
  approveUser,
  rejectUser
} from '../../config'
import type { Route, RouteCtx } from './index'

function parseUserId(body: Record<string, unknown>): number | null {
  const raw = body.userId
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function snapshot(): {
  approved: ReturnType<typeof getApprovedProfiles>
  pending: ReturnType<typeof getPendingRequests>
} {
  return { approved: getApprovedProfiles(), pending: getPendingRequests() }
}

function listUsers(c: RouteCtx): void {
  c.json(200, snapshot())
}

function approve(c: RouteCtx): void {
  const id = parseUserId(c.body)
  if (id === null) {
    c.json(400, { error: 'userId must be a finite number' })
    return
  }
  approveUser(id)
  c.json(200, { ok: true, ...snapshot() })
}

/** Used for both rejecting a pending request and revoking an approved user —
 *  both end in the same backend op (drop + ignore future requests). */
function reject(c: RouteCtx): void {
  const id = parseUserId(c.body)
  if (id === null) {
    c.json(400, { error: 'userId must be a finite number' })
    return
  }
  rejectUser(id)
  c.json(200, { ok: true, ...snapshot() })
}

export const userRoutes: Route[] = [
  { method: 'GET', path: '/api/users', ownerOnly: true, handler: listUsers },
  { method: 'POST', path: '/api/users/approve', ownerOnly: true, handler: approve },
  { method: 'POST', path: '/api/users/reject', ownerOnly: true, handler: reject },
  { method: 'POST', path: '/api/users/revoke', ownerOnly: true, handler: reject }
]
