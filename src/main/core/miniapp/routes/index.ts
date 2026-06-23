import type { IncomingMessage, ServerResponse } from 'node:http'
import { stateRoutes } from './state'

export interface RouteCtx {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  auth: { userId: number; isOwner: boolean }
  body: Record<string, unknown>
  json: (status: number, payload: unknown) => void
}
export interface Route {
  method: 'GET' | 'POST'
  path: string
  ownerOnly: boolean
  handler: (ctx: RouteCtx) => void | Promise<void>
}

// Wave 2 agents append their arrays here:
//   import { chatRoutes } from './chat'  → ...chatRoutes
export const ROUTES: Route[] = [...stateRoutes]
