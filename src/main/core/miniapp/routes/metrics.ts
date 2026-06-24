import { getMetrics } from '../../monitor'
import type { Route, RouteCtx } from './index'

/** GET /api/metrics?id=<botId>&n=<count> → live CPU/mem samples from the monitor. */
function getMetricsRoute(c: RouteCtx): void {
  const id = c.url.searchParams.get('id') ?? ''
  const n = Math.min(120, Math.max(10, Number(c.url.searchParams.get('n')) || 60))
  c.json(200, { samples: getMetrics(id, n) })
}

export const metricsRoutes: Route[] = [
  { method: 'GET', path: '/api/metrics', ownerOnly: false, handler: getMetricsRoute }
]
