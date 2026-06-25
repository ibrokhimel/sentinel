# Multi-Tenant AI Metering (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce per-tenant daily AI caps (chat/ask/fix) on the host's shared provider key so non-host users cannot run up unbounded spend; host is unlimited.

**Architecture:** A single `checkAndCountAi(uid, isHost, kind)` helper in `config.ts` does read-modify-write of a new `aiUsage` map (per-user, per-day counters) and returns allow/deny. Every AI entry point (Mini App `chat.ts` stream, control-bot `runAgentSession`/`startAgentForBot`) calls it after the existing provider-ready check and before running the agent; on deny it sends a friendly "limit reached" message. A read-only `getAiUsage` feeds a small quota line in the UI.

**Tech Stack:** TypeScript (Node ESM), Vitest, Electron main process. Config JSON at `SENTINEL_HOME/config.json`.

## Global Constraints

- Do NOT modify: `src/main/core/__tests__/integration.launchd.test.ts`, `src/main/core/launchctl.ts`, `src/main/core/monitor.ts`.
- Any new persisted config field MUST be carried through `readStored()` in `config.ts` (it reconstructs from a whitelist and silently drops unlisted keys — recurring bug class). Include a round-trip test.
- Host is identified by `getHostUid()`; the host is unlimited and is NEVER counted (no write to `aiUsage` for the host).
- Default daily limits live in `getLimits().aiPerDay` = `{ chat: 30, ask: 20, fix: 1 }` (already in config from Phase 1). Do not hardcode new limit numbers anywhere except the existing default literal.
- Counting order at every AI call site: provider-ready/input checks FIRST, then `checkAndCountAi`, then (if ok) run. A not-configured-provider or empty-message error must NOT consume quota.
- `aiUsage` keys are `String(uid)`. "Today" is the host machine local date `YYYY-MM-DD`.
- In embedded frontend view strings (`miniapp/frontend/**`), do NOT use backtick template literals or `${}`. (Plain `config.ts`/route `.ts` files MAY use template literals normally.)
- Run the FULL suite with `npm test`. Typecheck: `npm run typecheck`. Build: `npm run build`. Local commits only; no push; no secrets.

---

### Task 1: Metering store + helpers (config.ts)

**Files:**
- Modify: `src/main/core/config.ts`
- Test: `src/main/core/__tests__/config.aiusage.test.ts` (create)

**Interfaces:**
- Consumes: existing `readStored`, `writeStored`, `getHostUid`, `StoredConfig.limits` (`{ maxBotsPerTenant, aiPerDay:{chat,ask,fix} }`).
- Produces:
  - `type AiKind = 'chat' | 'ask' | 'fix'`
  - `checkAndCountAi(uid: number, isHost: boolean, kind: AiKind): { ok: boolean; remaining: number }`
  - `getAiUsage(uid: number, isHost: boolean): { used: { chat: number; ask: number; fix: number }; limits: { chat: number; ask: number; fix: number }; unlimited: boolean }`

- [ ] **Step 1: Write the failing test**

Create `src/main/core/__tests__/config.aiusage.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const files = new Map<string, string>()
vi.mock('node:fs', () => ({
  existsSync: (p: string) => files.has(p),
  readFileSync: (p: string) => {
    const v = files.get(p)
    if (v === undefined) throw new Error('ENOENT ' + p)
    return v
  },
  writeFileSync: (p: string, d: string) => void files.set(p, d),
  mkdirSync: () => undefined
}))

import { SENTINEL_HOME } from '../paths'
import { join } from 'node:path'
import { checkAndCountAi, getAiUsage } from '../config'

const CONFIG = join(SENTINEL_HOME, 'config.json')
function readUsage(): Record<string, { date: string; chat: number; ask: number; fix: number }> {
  return (JSON.parse(files.get(CONFIG) || '{}').aiUsage) || {}
}

describe('AI usage metering', () => {
  beforeEach(() => files.clear())

  it('host is unlimited and is never counted', () => {
    const r = checkAndCountAi(1, true, 'fix')
    expect(r.ok).toBe(true)
    expect(readUsage()['1']).toBeUndefined() // no write for host
  })

  it('counts per kind and blocks at the limit (fix default = 1)', () => {
    expect(checkAndCountAi(7, false, 'fix')).toEqual({ ok: true, remaining: 0 })
    expect(checkAndCountAi(7, false, 'fix').ok).toBe(false) // second fix same day → blocked
    // ask has its own independent counter (limit 20)
    expect(checkAndCountAi(7, false, 'ask').ok).toBe(true)
  })

  it('rolls counters when the stored day is stale', () => {
    checkAndCountAi(7, false, 'fix') // uses fix today
    // force the stored row to a past date
    const cfg = JSON.parse(files.get(CONFIG)!)
    cfg.aiUsage['7'].date = '2000-01-01'
    files.set(CONFIG, JSON.stringify(cfg))
    expect(checkAndCountAi(7, false, 'fix').ok).toBe(true) // new day → allowed again
  })

  it('getAiUsage reports used/limits; unlimited for host; no mutation', () => {
    checkAndCountAi(7, false, 'ask')
    const u = getAiUsage(7, false)
    expect(u.used.ask).toBe(1)
    expect(u.limits.fix).toBe(1)
    expect(u.unlimited).toBe(false)
    expect(getAiUsage(1, true).unlimited).toBe(true)
  })
})
```

- [ ] **Step 2: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/config.aiusage.test.ts`
Expected: FAIL (`checkAndCountAi`/`getAiUsage` not exported).

- [ ] **Step 3: Implement in `config.ts`**

Add `aiUsage` to the `StoredConfig` interface (after `limits`):

```ts
  aiUsage?: Record<string, { date: string; chat: number; ask: number; fix: number }>
```

Carry it through `readStored()` (in the returned object, alongside `limits`):

```ts
      aiUsage: parsed.aiUsage ?? {},
```

Add the helpers (near `getLimits`):

```ts
export type AiKind = 'chat' | 'ask' | 'fix'

function aiToday(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** Check (and, if allowed, consume) one unit of a tenant's daily AI quota.
 *  Host is unlimited and never counted. */
export function checkAndCountAi(uid: number, isHost: boolean, kind: AiKind): { ok: boolean; remaining: number } {
  if (isHost) return { ok: true, remaining: Infinity }
  const c = readStored()
  const limit = (c.limits ?? { maxBotsPerTenant: 5, aiPerDay: { chat: 30, ask: 20, fix: 1 } }).aiPerDay[kind]
  const usage = c.aiUsage ?? {}
  const key = String(uid)
  const today = aiToday()
  let row = usage[key]
  if (!row || row.date !== today) row = { date: today, chat: 0, ask: 0, fix: 0 }
  if (row[kind] >= limit) {
    usage[key] = row
    c.aiUsage = usage
    writeStored(c)
    return { ok: false, remaining: 0 }
  }
  row[kind] += 1
  usage[key] = row
  c.aiUsage = usage
  writeStored(c)
  return { ok: true, remaining: Math.max(0, limit - row[kind]) }
}

/** Read-only quota view for display (rolls a stale day to zeros in the returned value only). */
export function getAiUsage(
  uid: number,
  isHost: boolean
): { used: { chat: number; ask: number; fix: number }; limits: { chat: number; ask: number; fix: number }; unlimited: boolean } {
  const c = readStored()
  const limits = (c.limits ?? { maxBotsPerTenant: 5, aiPerDay: { chat: 30, ask: 20, fix: 1 } }).aiPerDay
  if (isHost) return { used: { chat: 0, ask: 0, fix: 0 }, limits, unlimited: true }
  const row = (c.aiUsage ?? {})[String(uid)]
  const used =
    row && row.date === aiToday()
      ? { chat: row.chat, ask: row.ask, fix: row.fix }
      : { chat: 0, ask: 0, fix: 0 }
  return { used, limits, unlimited: false }
}
```

- [ ] **Step 4: Run the test; expect pass**

Run: `npx vitest run src/main/core/__tests__/config.aiusage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit (local)**

```bash
git add src/main/core/config.ts src/main/core/__tests__/config.aiusage.test.ts
git commit -m "feat(metering): per-tenant daily AI usage store + checkAndCountAi/getAiUsage"
```

---

### Task 2: Enforce in the Mini App chat stream (chat.ts)

**Files:**
- Modify: `src/main/core/miniapp/routes/chat.ts`
- Test: `src/main/core/__tests__/miniapp.chat-meter.test.ts` (create)

**Interfaces:**
- Consumes: `checkAndCountAi`, `AiKind` (Task 1); existing `stream` handler, `provider()`, `S.getSessionFor`, `runAgent`.
- Produces: the stream refuses (SSE error) and does NOT call `runAgent` when the caller is over their daily cap for the session's kind.

- [ ] **Step 1: Write the failing test**

Create `src/main/core/__tests__/miniapp.chat-meter.test.ts`. This mocks the agent runtime and the metering helper so we can assert ordering (over-limit → no agent run). Adapt the mock specifiers to match what `chat.ts` imports.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runAgent = vi.fn(async () => 'ok')
vi.mock('../../agent/runtime', () => ({ runAgent: (...a: unknown[]) => runAgent(...a) }))
const checkAndCountAi = vi.fn(() => ({ ok: true, remaining: 5 }))
vi.mock('../../config', () => ({
  getAgentConfig: () => ({ baseUrl: 'http://x', apiKey: 'k', model: 'm', ready: true }),
  getAppConfig: () => ({ autoApprove: false }),
  checkAndCountAi: (...a: unknown[]) => checkAndCountAi(...a)
}))
vi.mock('../sessions', () => ({
  MAIN_ID: 'main',
  mainIdFor: (u: number) => 'main:' + u,
  getSessionFor: () => ({ id: 'main:7', mode: 'ask', botId: 'a', messages: [] }),
  appendTurn: () => {}
}))
vi.mock('../../supervisor', () => ({ getBot: async () => ({ manifest: { id: 'a' }, dir: '/d' }) }))
vi.mock('../authz', () => ({ can: () => true, botsVisibleTo: () => [{ id: 'a' }], assertCap: () => ({ id: 'a' }) }))
vi.mock('../../registry', () => ({ findEntry: () => ({ id: 'a', ownerId: 7 }) }))

import { chatRoutes } from '../miniapp/routes/chat'

function streamCtx(auth: { userId: number; isOwner: boolean }) {
  const writes: string[] = []
  const res: Record<string, unknown> = {
    writeHead: () => {}, write: (s: string) => { writes.push(s); return true }, end: () => {}, on: () => {}, writableEnded: false
  }
  const route = chatRoutes.find((r) => r.path === '/api/chat/stream')!
  return { p: route.handler({ auth, res, body: { id: 'main:7', message: 'hi' }, json: () => {} } as never), writes }
}

describe('chat AI metering', () => {
  beforeEach(() => { runAgent.mockClear(); checkAndCountAi.mockReset(); checkAndCountAi.mockReturnValue({ ok: true, remaining: 5 }) })

  it('runs the agent when under the cap (kind=ask)', async () => {
    const { p } = streamCtx({ userId: 7, isOwner: false })
    await p
    expect(checkAndCountAi).toHaveBeenCalledWith(7, false, 'ask')
    expect(runAgent).toHaveBeenCalled()
  })

  it('refuses and does NOT run the agent when over the cap', async () => {
    checkAndCountAi.mockReturnValue({ ok: false, remaining: 0 })
    const { p, writes } = streamCtx({ userId: 7, isOwner: false })
    await p
    expect(runAgent).not.toHaveBeenCalled()
    expect(writes.join('')).toMatch(/limit reached/i)
  })
})
```

- [ ] **Step 2: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/miniapp.chat-meter.test.ts`
Expected: FAIL (metering not wired; `runAgent` called even when `checkAndCountAi` returns ok:false). Note: if the existing mocks in this file don't match `chat.ts`'s real imports, the failing run will show import errors — fix the mock specifiers to match `chat.ts` (it imports `runAgent` from `'../../agent/runtime'`, config from `'../../config'`, sessions as `'../sessions'`, etc.) before proceeding.

- [ ] **Step 3: Implement in `chat.ts`**

Add `checkAndCountAi` to the existing `'../../config'` import. In `stream`, immediately AFTER the empty-message guard (the `if (!msg) { ... return void res.end() }` block, ~line 77) and BEFORE `const prov = ...` (~line 78), insert:

```ts
  const aiKind = sess.mode === 'ask' ? 'ask' : 'chat'
  const meter = checkAndCountAi(c.auth.userId, c.auth.isOwner, aiKind)
  if (!meter.ok) {
    send({ type: 'error', message: 'Daily AI limit reached — resets tomorrow.' })
    return void res.end()
  }
```

(`sess` is already resolved and non-null at this point; `send` and `res` are already in scope.)

- [ ] **Step 4: Run the test; expect pass**

Run: `npx vitest run src/main/core/__tests__/miniapp.chat-meter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full suite green.
```bash
git add src/main/core/miniapp/routes/chat.ts src/main/core/__tests__/miniapp.chat-meter.test.ts
git commit -m "feat(metering): enforce per-tenant AI cap in the Mini App chat stream"
```

---

### Task 3: Enforce in the control bot (telegramBot.ts)

**Files:**
- Modify: `src/main/core/telegramBot.ts`
- Test: `src/main/core/__tests__/telegramBot.meter.test.ts` (create)

**Interfaces:**
- Consumes: `checkAndCountAi`, `AiKind` (Task 1); existing `runAgentSession(chatId, arg, allowWrites)` and `startAgentForBot(chatId, botId, allowWrites)`; `isAuthorized`, `getAgentConfig`.
- Produces: `/ask` and `/fix` (and the ask/fix buttons) refuse and send a limit message when the acting user is over their daily cap; host unaffected. Extract a tiny pure helper `aiKindFor(allowWrites)` to keep the kind mapping testable.

- [ ] **Step 1: Write the failing test**

Create `src/main/core/__tests__/telegramBot.meter.test.ts` testing the pure mapping helper you will add:

```ts
import { describe, it, expect } from 'vitest'
import { aiKindFor } from '../telegramBot'

describe('control-bot AI kind mapping', () => {
  it('maps /fix (allowWrites) to fix and /ask to ask', () => {
    expect(aiKindFor(true)).toBe('fix')
    expect(aiKindFor(false)).toBe('ask')
  })
})
```

- [ ] **Step 2: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/telegramBot.meter.test.ts`
Expected: FAIL (`aiKindFor` not exported).

- [ ] **Step 3: Implement in `telegramBot.ts`**

Add `checkAndCountAi` (and type `AiKind` if needed) to the existing `'./config'` import. Add a module-level helper near the other exported helpers:

```ts
export function aiKindFor(allowWrites: boolean): 'ask' | 'fix' {
  return allowWrites ? 'fix' : 'ask'
}
```

In `runAgentSession(chatId, arg, allowWrites)`: it already early-returns when `!getAgentConfig().ready` and computes `const isOwner = isAuthorized(chatId, this.getConfig().ownerChatId)` and resolves the (owned-only) `bot`. AFTER the bot is resolved and BEFORE `await this.runAgentForBot(...)`, insert:

```ts
    const meter = checkAndCountAi(chatId, isOwner, aiKindFor(allowWrites))
    if (!meter.ok) {
      await this.send(chatId, '🚦 Daily AI limit reached — resets tomorrow.')
      return
    }
```

In `startAgentForBot(chatId, botId, allowWrites)`: it already early-returns when `!getAgentConfig().ready`. After that guard and after it resolves `isOwner`/visibility (it computes `const isOwner = isAuthorized(chatId, this.getConfig().ownerChatId)`), before starting the run, insert the same block:

```ts
    const meter = checkAndCountAi(chatId, isOwner, aiKindFor(allowWrites))
    if (!meter.ok) {
      await this.send(chatId, '🚦 Daily AI limit reached — resets tomorrow.')
      return
    }
```

(If `isOwner` is not already in scope at the insertion point in either method, compute it with `const isOwner = isAuthorized(chatId, this.getConfig().ownerChatId)` first. Do not change any other logic.)

- [ ] **Step 4: Run the test; expect pass**

Run: `npx vitest run src/main/core/__tests__/telegramBot.meter.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full suite green.
```bash
git add src/main/core/telegramBot.ts src/main/core/__tests__/telegramBot.meter.test.ts
git commit -m "feat(metering): enforce per-tenant AI cap on control-bot /ask and /fix"
```

---

### Task 4: Quota visibility (/api/state + tenant UI line)

**Files:**
- Modify: `src/main/core/miniapp/routes/state.ts`
- Modify: `src/main/core/miniapp/frontend/views/settings.ts`
- Test: `src/main/core/__tests__/miniapp.state-ai.test.ts` (create)

**Interfaces:**
- Consumes: `getAiUsage` (Task 1); existing `getState` handler and `auth`.
- Produces: `/api/state` payload gains `ai: getAiUsage(c.auth.userId, c.auth.isOwner)`; the tenant settings view shows a small "AI today" line.

- [ ] **Step 1: Write the failing test**

Create `src/main/core/__tests__/miniapp.state-ai.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('../supervisor', () => ({ listBots: async () => [] }))
vi.mock('../authz', () => ({ botsVisibleTo: () => [], assertCap: () => ({}), can: () => false }))
vi.mock('../../registry', () => ({ findEntry: () => undefined }))
vi.mock('../../telegramBot', () => ({ tailBotLogs: () => '' }))
vi.mock('../../config', () => ({
  getAppConfig: () => ({}),
  setAutoApprove: () => {}, setAutoUpdateEnabled: () => {}, setNotifyConfig: () => {}, setAgentConfig: () => {},
  getAiUsage: (uid: number, isHost: boolean) => ({ used: { chat: 0, ask: 3, fix: 0 }, limits: { chat: 30, ask: 20, fix: 1 }, unlimited: isHost })
}))

import { stateRoutes } from '../miniapp/routes/state'

function getState(auth: { userId: number; isOwner: boolean }) {
  const json = vi.fn()
  const route = stateRoutes.find((r) => r.path === '/api/state' && r.method === 'GET')!
  return Promise.resolve(route.handler({ auth, json, url: new URL('http://x/api/state'), body: {} } as never)).then(() => json.mock.calls[0][1] as Record<string, unknown>)
}

describe('state AI quota', () => {
  it('includes the requester ai quota (tenant)', async () => {
    const p = await getState({ userId: 7, isOwner: false })
    expect((p.ai as { used: { ask: number } }).used.ask).toBe(3)
    expect((p.ai as { unlimited: boolean }).unlimited).toBe(false)
  })
  it('marks host unlimited', async () => {
    const p = await getState({ userId: 1, isOwner: true })
    expect((p.ai as { unlimited: boolean }).unlimited).toBe(true)
  })
})
```

- [ ] **Step 2: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/miniapp.state-ai.test.ts`
Expected: FAIL (`payload.ai` undefined).

- [ ] **Step 3: Implement**

In `state.ts`: add `getAiUsage` to the `'../../config'` import. In `getState`, add `ai` to the response object:

```ts
  c.json(200, { bots, config: c.auth.isOwner ? getAppConfig() : null, owner: c.auth.isOwner, ai: getAiUsage(c.auth.userId, c.auth.isOwner) })
```

In `settings.ts` (the tenant branch — where `st.config` is null and the host-level message renders): append a small quota line using `st.ai`, with single-quoted concatenation (NO backticks/`${}`), e.g. build a string like `'AI today — ask '+st.ai.used.ask+'/'+st.ai.limits.ask+' · fix '+st.ai.used.fix+'/'+st.ai.limits.fix` inside a muted element, guarded by `if(st.ai && !st.ai.unlimited)`. Do not change the host (owner) branch.

- [ ] **Step 4: Run the test; expect pass**

Run: `npx vitest run src/main/core/__tests__/miniapp.state-ai.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Build + full suite + commit**

Run: `npm run build && npm test`
Expected: build succeeds (catches embedded-string slips); full suite green.
```bash
git add src/main/core/miniapp/routes/state.ts src/main/core/miniapp/frontend/views/settings.ts src/main/core/__tests__/miniapp.state-ai.test.ts
git commit -m "feat(metering): expose per-tenant AI quota in state + tenant UI line"
```

---

### Final verification (after all tasks)

- [ ] `npm run typecheck` → clean
- [ ] `npm test` → all green (Phase 1+2+3; 2 pre-existing skips remain)
- [ ] `npm run build` → succeeds
- [ ] Manual smoke: as a tenant, run `/fix` on your own bot twice — the second is refused with the limit message; `/ask` still works (separate counter); host has no limit; the Mini App settings shows "AI today — ask N/20 · fix N/1".

---

## Notes for the executor

- Host short-circuits in `checkAndCountAi` BEFORE any read/write — never persist `aiUsage` for the host.
- Keep the provider-ready check before metering at every call site, so a misconfigured provider never burns quota.
- Only `config.ts` owns the limit defaults (`{ chat: 30, ask: 20, fix: 1 }`); don't duplicate the numbers elsewhere.
- Date roll is by host local day; tests force a stale `date` to exercise the reset rather than mocking `Date`.
