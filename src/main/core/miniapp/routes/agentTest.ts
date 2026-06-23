import { getAgentConfig } from '../../config'
import { ping } from '../../agent/provider'
import type { Route } from './index'

export const agentTestRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/agent/test',
    ownerOnly: true,
    handler: async (c) => {
      const a = getAgentConfig()
      if (!a.ready) return c.json(200, { ok: false, error: 'not configured' })
      try {
        const ok = await ping({ baseUrl: a.baseUrl, apiKey: a.apiKey, model: a.model })
        c.json(200, { ok, model: a.model })
      } catch (e) {
        c.json(200, { ok: false, error: String((e as Error).message) })
      }
    }
  }
]
