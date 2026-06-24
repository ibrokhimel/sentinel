/**
 * health.ts — Credential health checks.
 *
 * Replaces the meaningless "token expires in N days" idea (Telegram bot tokens
 * never expire) with a live validity check of the three credentials Sentinel
 * actually depends on: the bot token, the GitHub token, and the AI key. Each
 * check is best-effort with a short timeout and never throws.
 *
 * POST /api/health/credentials → { telegram, github, ai } where each is
 *   { ok: boolean, detail: string }.
 */
import { getNotifyConfig, getGithubToken, getAgentConfig } from '../../config'
import { ping } from '../../agent/provider'
import type { Route } from './index'

interface Check {
  ok: boolean
  detail: string
}

const TIMEOUT_MS = 6000

async function checkTelegram(): Promise<Check> {
  const token = getNotifyConfig().token
  if (!token) return { ok: false, detail: 'not configured' }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const j = (await r.json()) as { ok?: boolean; result?: { username?: string } }
    if (j.ok && j.result?.username) return { ok: true, detail: '@' + j.result.username }
    return { ok: false, detail: 'invalid token' }
  } catch (e) {
    return { ok: false, detail: String((e as Error).message).slice(0, 80) }
  }
}

async function checkGithub(): Promise<Check> {
  const token = getGithubToken()
  if (!token) return { ok: false, detail: 'not configured' }
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: { Authorization: 'token ' + token, 'User-Agent': 'Sentinel', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (r.status === 401) return { ok: false, detail: 'invalid / expired' }
    if (!r.ok) return { ok: false, detail: 'HTTP ' + r.status }
    const j = (await r.json()) as { login?: string }
    const scopes = r.headers.get('x-oauth-scopes') ?? ''
    const repo = /\brepo\b/.test(scopes) ? '' : ' (no repo scope)'
    return { ok: true, detail: (j.login ? j.login : 'valid') + repo }
  } catch (e) {
    return { ok: false, detail: String((e as Error).message).slice(0, 80) }
  }
}

async function checkAi(): Promise<Check> {
  const a = getAgentConfig()
  if (!a.ready) return { ok: false, detail: 'not configured' }
  try {
    const ok = await ping({ baseUrl: a.baseUrl, apiKey: a.apiKey, model: a.model })
    return ok ? { ok: true, detail: a.model } : { ok: false, detail: 'no response' }
  } catch (e) {
    return { ok: false, detail: String((e as Error).message).slice(0, 80) }
  }
}

export const healthRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/health/credentials',
    ownerOnly: true,
    handler: async (c) => {
      const [telegram, github, ai] = await Promise.all([checkTelegram(), checkGithub(), checkAi()])
      c.json(200, { telegram, github, ai })
    }
  }
]
