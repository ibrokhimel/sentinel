import * as sup from '../../supervisor'
import { getAppConfig, setAutoApprove, setAutoUpdateEnabled, setNotifyConfig, setAgentConfig } from '../../config'
import { tailBotLogs } from '../../telegramBot'
import { botsVisibleTo, assertCap } from '../authz'
import type { Route, RouteCtx } from './index'

export const SECRET_KEY_RE = /TOKEN|HASH|SECRET|PASSWORD|KEY|API_ID|SESSION/i

async function getState(c: RouteCtx): Promise<void> {
  const visible = new Set(botsVisibleTo(c.auth.userId, c.auth.isOwner).map((e) => e.id))
  const bots = (await sup.listBots()).filter((b) => visible.has(b.manifest.id))
  c.json(200, { bots, config: c.auth.isOwner ? getAppConfig() : null, owner: c.auth.isOwner })
}
async function getLogs(c: RouteCtx): Promise<void> {
  const id = c.url.searchParams.get('id') ?? ''
  assertCap(c.auth.userId, c.auth.isOwner, id, 'viewLogs')
  const n = Math.min(200, Math.max(10, Number(c.url.searchParams.get('n')) || 60))
  c.json(200, { text: tailBotLogs(id, n) })
}
function getEnv(c: RouteCtx): void {
  const id = c.url.searchParams.get('id') ?? ''
  assertCap(c.auth.userId, c.auth.isOwner, id, 'editEnv')
  const env = sup.getEnv(id)
  const current: Record<string, string> = {}
  const secretKeys: string[] = []
  for (const k of env.keys) {
    const isSecret = SECRET_KEY_RE.test(k)
    if (isSecret) secretKeys.push(k)
    current[k] = isSecret ? '' : (env.current[k] ?? '')
  }
  const hasValue: Record<string, boolean> = {}
  for (const k of env.keys) hasValue[k] = Boolean(env.current[k])
  c.json(200, { keys: env.keys, current, secretKeys, hasValue })
}
async function postAction(c: RouteCtx): Promise<void> {
  const b = c.body as { id?: string; action?: string }
  const id = String(b.id ?? '')
  assertCap(c.auth.userId, c.auth.isOwner, id, 'startStop')
  switch (b.action) {
    case 'start': await sup.start(id); break
    case 'stop': await sup.stop(id); break
    case 'restart': await sup.restart(id); break
    case 'autostart-on': await sup.setAutostart(id, true); break
    case 'autostart-off': await sup.setAutostart(id, false); break
    default: return c.json(400, { error: 'unknown action' })
  }
  c.json(200, { ok: true, bot: await sup.getBot(id) })
}
async function postEnv(c: RouteCtx): Promise<void> {
  const b = c.body as { id?: string; values?: Record<string, string> }
  const id = String(b.id ?? '')
  assertCap(c.auth.userId, c.auth.isOwner, id, 'editEnv')
  const incoming = b.values ?? {}
  const existing = sup.getEnv(id).current
  const merged: Record<string, string> = { ...existing }
  for (const [k, v] of Object.entries(incoming)) {
    if (v === '' && SECRET_KEY_RE.test(k) && existing[k]) continue
    merged[k] = v
  }
  await sup.saveEnv(id, merged)
  c.json(200, { ok: true })
}
function postSettings(c: RouteCtx): void {
  const b = c.body
  if (typeof b.autoApprove === 'boolean') setAutoApprove(b.autoApprove)
  if (typeof b.autoUpdateEnabled === 'boolean') setAutoUpdateEnabled(b.autoUpdateEnabled)
  if (b.notify && typeof b.notify === 'object') {
    const n = b.notify as { enabled?: boolean; chatId?: string }
    setNotifyConfig({ enabled: n.enabled, chatId: n.chatId })
  }
  if (b.agent && typeof b.agent === 'object') {
    const a = b.agent as { baseUrl?: string; model?: string; key?: string }
    setAgentConfig({ baseUrl: a.baseUrl, model: a.model, key: a.key })
  }
  c.json(200, { ok: true, config: getAppConfig() })
}

export const stateRoutes: Route[] = [
  { method: 'GET', path: '/api/state', ownerOnly: false, handler: getState },
  { method: 'GET', path: '/api/logs', ownerOnly: false, handler: getLogs },
  { method: 'GET', path: '/api/env', ownerOnly: false, handler: getEnv },
  { method: 'POST', path: '/api/action', ownerOnly: false, handler: postAction },
  { method: 'POST', path: '/api/env', ownerOnly: false, handler: postEnv },
  { method: 'POST', path: '/api/settings', ownerOnly: true, handler: postSettings }
]
