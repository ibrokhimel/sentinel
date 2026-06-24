import { getMetrics } from '../../monitor'
import { assertCap } from '../authz'
import type { Route, RouteCtx } from './index'

/** GET /api/metrics?id=<botId>&n=<count> → live CPU/mem samples from the monitor. */
function getMetricsRoute(c: RouteCtx): void {
  const id = c.url.searchParams.get('id') ?? ''
  assertCap(c.auth.userId, c.auth.isOwner, id, 'view')
  const n = Math.min(120, Math.max(10, Number(c.url.searchParams.get('n')) || 60))
  c.json(200, { samples: getMetrics(id, n) })
}

export const metricsRoutes: Route[] = [
  { method: 'GET', path: '/api/metrics', ownerOnly: false, handler: getMetricsRoute }
]
