/**
 * git.ts — Git action routes: update (pull), push-to-live, apply (rebuild Sentinel)
 *
 * All routes are ownerOnly.
 * The apply route spawns a bounded child process; it does NOT restart the app
 * automatically — KeepAlive picks up the new out/ on the next agent cycle.
 */
import * as sup from '../../supervisor'
import type { Route, RouteCtx } from './index'
import { spawn } from 'node:child_process'

async function update(c: RouteCtx): Promise<void> {
  try {
    const id = String((c.body as Record<string, unknown>).id ?? '')
    const bot = await sup.updateBot(id, () => {})
    c.json(200, { ok: true, sha: (bot as unknown as Record<string, unknown>).sha ?? null })
  } catch (e) {
    c.json(500, { error: String((e as Error).message) })
  }
}

async function push(c: RouteCtx): Promise<void> {
  try {
    const id = String((c.body as Record<string, unknown>).id ?? '')
    const r = await sup.pushLive(id, () => {})
    c.json(200, { ok: true, ...r })
  } catch (e) {
    c.json(500, { error: String((e as Error).message) })
  }
}

function apply(c: RouteCtx): void {
  const home = process.env.SENTINEL_HOME || process.cwd()
  let done = false
  let child: ReturnType<typeof spawn>
  try {
    child = spawn('/bin/bash', ['-lc', 'npm run typecheck && npm run build'], {
      cwd: home,
      stdio: 'pipe',
    })
  } catch (e) {
    c.json(500, { error: String((e as Error)?.message ?? e) })
    return
  }
  let out = ''
  child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
  child.stderr?.on('data', (d: Buffer) => { out += d.toString() })
  child.on('error', (e: Error) => {
    if (done) return; done = true
    c.json(500, { error: String(e?.message ?? e) })
  })
  child.on('exit', (code: number | null) => {
    if (done) return; done = true
    if (code === 0) {
      c.json(200, { ok: true })
    } else {
      c.json(500, { error: 'build failed', tail: out.slice(-1500) })
    }
  })
}

export const gitRoutes: Route[] = [
  { method: 'POST', path: '/api/git/update', ownerOnly: true, handler: update },
  { method: 'POST', path: '/api/git/push',   ownerOnly: true, handler: push },
  { method: 'POST', path: '/api/git/apply',  ownerOnly: true, handler: apply },
]
