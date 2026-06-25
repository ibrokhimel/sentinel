# Multi-Tenant Collaboration (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a bot owner add another approved tenant as a collaborator on their bot with granular per-capability toggles, reveal secrets to capable collaborators, and keep the Telegram control bot owned-only.

**Architecture:** Add registry helpers to write the existing `collaborators` map; a new owner/host-only `collaborators` route module for CRUD; a `viewSecrets`-gated reveal branch in `getEnv`; an owner-only Collaborators card in the bot-detail UI (`fleet.ts`); and narrow the control bot's bot list to owned-only. The `can()` chokepoint and per-capability route gating already exist from Phase 1, so enforcement is mostly already correct.

**Tech Stack:** TypeScript (Node ESM), Vitest, Electron main process. Registry JSON at `SENTINEL_HOME/registry.json`.

## Global Constraints

- Do NOT modify: `src/main/core/__tests__/integration.launchd.test.ts`, `src/main/core/launchctl.ts`, `src/main/core/monitor.ts`.
- In embedded frontend view strings (`miniapp/frontend/**`), do NOT use backtick template literals or `${}` inside the embedded JS strings — use single-quoted concatenation matching surrounding code.
- Identity is `RouteCtx.auth = { userId: number; isOwner: boolean }` (`isOwner` = host). Never re-derive identity in a handler.
- Managing collaborators and removing a bot are owner/host-only (no capability grants them). The check is `c.auth.isOwner || entry?.ownerId === c.auth.userId`.
- The six capabilities are exactly: `viewLogs`, `chat`, `startStop`, `deploy`, `editEnv`, `viewSecrets` (all optional booleans on the `Capabilities` interface in `registry.ts`).
- Run the FULL suite with `npm test` (not a `-t` name filter). Typecheck: `npm run typecheck`. Build (compiles embedded frontend): `npm run build`.
- Tests use in-memory `node:fs` mocks (see `__tests__/registry.ownership.test.ts`) or mock collaborating modules — never touch real `~/Documents/Sentinel` files.
- Local commits only. Do not push.

---

### Task 1: Registry collaborator helpers

**Files:**
- Modify: `src/main/core/registry.ts`
- Test: `src/main/core/__tests__/registry.collaborators.test.ts` (create)

**Interfaces:**
- Consumes: existing `Capabilities`, `RegistryEntry`, `readRegistry`, `writeRegistry`, `findEntry`.
- Produces:
  - `setCollaborator(botId: string, uid: number, caps: Capabilities): void`
  - `removeCollaborator(botId: string, uid: number): void`

- [ ] **Step 1: Write the failing test**

Create `src/main/core/__tests__/registry.collaborators.test.ts`:

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
  mkdirSync: () => undefined,
  cpSync: () => undefined,
  rmSync: () => undefined
}))
vi.mock('../config', () => ({ getHostUid: () => 1 }))

import { REGISTRY_PATH } from '../paths'
import { readRegistry, setCollaborator, removeCollaborator } from '../registry'

function seed(): void {
  files.set(REGISTRY_PATH, JSON.stringify([{ id: 'a', name: 'A', dirName: 'a', ownerId: 7 }]))
}

describe('registry collaborators', () => {
  beforeEach(() => { files.clear(); seed() })

  it('adds a collaborator with only known capability keys', () => {
    setCollaborator('a', 2, { viewLogs: true, editEnv: true, bogus: true } as never)
    const e = readRegistry().find((x) => x.id === 'a')!
    expect(e.collaborators!['2']).toEqual({ viewLogs: true, editEnv: true })
  })

  it('replaces an existing collaborator capability set', () => {
    setCollaborator('a', 2, { viewLogs: true })
    setCollaborator('a', 2, { startStop: true })
    expect(readRegistry().find((x) => x.id === 'a')!.collaborators!['2']).toEqual({ startStop: true })
  })

  it('removes a collaborator and prunes the empty map', () => {
    setCollaborator('a', 2, { viewLogs: true })
    removeCollaborator('a', 2)
    const e = readRegistry().find((x) => x.id === 'a')!
    expect(e.collaborators).toBeUndefined()
  })

  it('no-ops on an unknown bot', () => {
    expect(() => setCollaborator('nope', 2, { viewLogs: true })).not.toThrow()
    expect(() => removeCollaborator('nope', 2)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/registry.collaborators.test.ts`
Expected: FAIL (`setCollaborator`/`removeCollaborator` not exported).

- [ ] **Step 3: Implement in `registry.ts`** (add after `setBotOwner`)

```ts
const CAP_KEYS = ['viewLogs', 'chat', 'startStop', 'deploy', 'editEnv', 'viewSecrets'] as const

/** Add or replace a collaborator's capability set on a bot (known keys only). */
export function setCollaborator(botId: string, uid: number, caps: Capabilities): void {
  const entries = readRegistry()
  const e = entries.find((x) => x.id === botId)
  if (!e) return
  const clean: Capabilities = {}
  for (const k of CAP_KEYS) if (caps[k] === true) clean[k] = true
  const map = e.collaborators ?? {}
  map[String(uid)] = clean
  e.collaborators = map
  writeRegistry(entries)
}

/** Remove a collaborator from a bot; prune the map if it becomes empty. */
export function removeCollaborator(botId: string, uid: number): void {
  const entries = readRegistry()
  const e = entries.find((x) => x.id === botId)
  if (!e || !e.collaborators) return
  delete e.collaborators[String(uid)]
  if (Object.keys(e.collaborators).length === 0) delete e.collaborators
  writeRegistry(entries)
}
```

- [ ] **Step 4: Run the test; expect pass**

Run: `npx vitest run src/main/core/__tests__/registry.collaborators.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit (local)**

```bash
git add src/main/core/registry.ts src/main/core/__tests__/registry.collaborators.test.ts
git commit -m "feat(collab): registry setCollaborator/removeCollaborator helpers"
```

---

### Task 2: Collaborator management routes

**Files:**
- Create: `src/main/core/miniapp/routes/collaborators.ts`
- Modify: `src/main/core/miniapp/routes/index.ts` (register routes)
- Test: `src/main/core/__tests__/miniapp.collaborators.test.ts` (create)

**Interfaces:**
- Consumes: `auth`; `findEntry`, `setCollaborator`, `removeCollaborator` (Task 1); `getApprovedProfiles`, `getApprovedUsers`, `getUserProfile`, `getHostUid` (config); `Capabilities` (registry).
- Produces: `collaboratorRoutes: Route[]` with `GET /api/bots/collaborators`, `POST /api/bots/collaborators`, `POST /api/bots/collaborators/remove` (all `ownerOnly: false`, owner/host-of-bot enforced inside).

- [ ] **Step 1: Write the failing test**

Create `src/main/core/__tests__/miniapp.collaborators.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const set = vi.fn()
const remove = vi.fn()
let entry: Record<string, unknown> | undefined
vi.mock('../registry', () => ({
  findEntry: () => entry,
  setCollaborator: (...a: unknown[]) => set(...a),
  removeCollaborator: (...a: unknown[]) => remove(...a)
}))
vi.mock('../config', () => ({
  getApprovedProfiles: () => [
    { id: 1, username: 'host' }, { id: 7, username: 'owner' },
    { id: 2, username: 'bob' }, { id: 3, username: 'sam' }
  ],
  getApprovedUsers: () => [1, 7, 2, 3],
  getUserProfile: (id: number) => ({ id, username: 'u' + id }),
  getHostUid: () => 1
}))

import { collaboratorRoutes } from '../miniapp/routes/collaborators'

function call(path: string, method: string, body: unknown, auth: { userId: number; isOwner: boolean }, query = '') {
  const json = vi.fn()
  const route = collaboratorRoutes.find((r) => r.path === path && r.method === method)!
  const url = new URL('http://x' + path + query)
  return Promise.resolve(route.handler({ body, json, auth, url } as never)).then(() => json)
}

describe('collaborator routes', () => {
  beforeEach(() => { set.mockClear(); remove.mockClear(); entry = { id: 'a', ownerId: 7, collaborators: { '2': { viewLogs: true } } } })

  it('GET lists collaborators + addable tenants (excludes host/owner/existing)', async () => {
    const json = await call('/api/bots/collaborators', 'GET', {}, { userId: 7, isOwner: false }, '?botId=a')
    const payload = json.mock.calls[0][1] as { collaborators: { id: number }[]; addable: { id: number }[] }
    expect(payload.collaborators.map((c) => c.id)).toEqual([2])
    expect(payload.addable.map((u) => u.id).sort()).toEqual([3]) // 1=host,7=owner,2=existing excluded
  })

  it('owner can add a collaborator with coerced caps', async () => {
    const json = await call('/api/bots/collaborators', 'POST', { botId: 'a', userId: 3, capabilities: { viewLogs: true } }, { userId: 7, isOwner: false })
    expect(set).toHaveBeenCalledWith('a', 3, { viewLogs: true })
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ ok: true }))
  })

  it('a non-owner non-host tenant is forbidden', async () => {
    const json = await call('/api/bots/collaborators', 'POST', { botId: 'a', userId: 3, capabilities: {} }, { userId: 99, isOwner: false })
    expect(json).toHaveBeenCalledWith(403, expect.objectContaining({ error: expect.any(String) }))
    expect(set).not.toHaveBeenCalled()
  })

  it('rejects adding a non-approved user', async () => {
    const json = await call('/api/bots/collaborators', 'POST', { botId: 'a', userId: 555, capabilities: {} }, { userId: 7, isOwner: false })
    expect(json).toHaveBeenCalledWith(400, expect.objectContaining({ error: expect.any(String) }))
  })

  it('owner can remove a collaborator', async () => {
    const json = await call('/api/bots/collaborators/remove', 'POST', { botId: 'a', userId: 2 }, { userId: 7, isOwner: false })
    expect(remove).toHaveBeenCalledWith('a', 2)
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ ok: true }))
  })
})
```

- [ ] **Step 2: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/miniapp.collaborators.test.ts`
Expected: FAIL (module `../miniapp/routes/collaborators` not found).

- [ ] **Step 3: Implement `collaborators.ts`**

Create `src/main/core/miniapp/routes/collaborators.ts`:

```ts
/**
 * collaborators.ts — per-bot collaborator management (owner/host of the bot only).
 * GET  /api/bots/collaborators?botId=  -> { collaborators, addable }
 * POST /api/bots/collaborators         { botId, userId, capabilities } -> { ok, ... }
 * POST /api/bots/collaborators/remove  { botId, userId } -> { ok, ... }
 */
import { findEntry, setCollaborator, removeCollaborator, type Capabilities } from '../../registry'
import { getApprovedProfiles, getApprovedUsers, getUserProfile, getHostUid } from '../../config'
import type { Route, RouteCtx } from './index'

const CAP_KEYS = ['viewLogs', 'chat', 'startStop', 'deploy', 'editEnv', 'viewSecrets'] as const

function cleanCaps(input: unknown): Capabilities {
  const out: Capabilities = {}
  const o = (input ?? {}) as Record<string, unknown>
  for (const k of CAP_KEYS) if (o[k] === true) out[k] = true
  return out
}

/** Owner-of-bot-or-host gate; returns the entry on success or null after sending 403/404. */
function ownerEntry(c: RouteCtx, botId: string): ReturnType<typeof findEntry> | null {
  const entry = findEntry(botId)
  if (!entry) { c.json(404, { error: 'no such bot' }); return null }
  if (!c.auth.isOwner && entry.ownerId !== c.auth.userId) { c.json(403, { error: 'only the bot owner can manage collaborators' }); return null }
  return entry
}

function snapshot(botId: string): { collaborators: Array<Capabilities & { id: number }>; addable: ReturnType<typeof getApprovedProfiles> } {
  const entry = findEntry(botId)
  const map = entry?.collaborators ?? {}
  const collaborators = Object.keys(map).map((uid) => {
    const p = getUserProfile(Number(uid))
    return { ...p, caps: map[uid] }
  }) as never
  const host = getHostUid()
  const existing = new Set(Object.keys(map).map(Number))
  const addable = getApprovedProfiles().filter(
    (p) => p.id !== host && p.id !== entry?.ownerId && !existing.has(p.id)
  )
  return { collaborators, addable }
}

function list(c: RouteCtx): void {
  const botId = c.url.searchParams.get('botId') ?? ''
  if (!ownerEntry(c, botId)) return
  c.json(200, snapshot(botId))
}

function add(c: RouteCtx): void {
  const b = c.body as { botId?: string; userId?: unknown; capabilities?: unknown }
  const botId = String(b.botId ?? '')
  const uid = Number(b.userId)
  if (!Number.isFinite(uid)) { c.json(400, { error: 'userId must be a finite number' }); return }
  if (!ownerEntry(c, botId)) return
  if (!getApprovedUsers().includes(uid)) { c.json(400, { error: 'user is not an approved tenant' }); return }
  setCollaborator(botId, uid, cleanCaps(b.capabilities))
  c.json(200, { ok: true, ...snapshot(botId) })
}

function remove(c: RouteCtx): void {
  const b = c.body as { botId?: string; userId?: unknown }
  const botId = String(b.botId ?? '')
  const uid = Number(b.userId)
  if (!Number.isFinite(uid)) { c.json(400, { error: 'userId must be a finite number' }); return }
  if (!ownerEntry(c, botId)) return
  removeCollaborator(botId, uid)
  c.json(200, { ok: true, ...snapshot(botId) })
}

export const collaboratorRoutes: Route[] = [
  { method: 'GET', path: '/api/bots/collaborators', ownerOnly: false, handler: list },
  { method: 'POST', path: '/api/bots/collaborators', ownerOnly: false, handler: add },
  { method: 'POST', path: '/api/bots/collaborators/remove', ownerOnly: false, handler: remove }
]
```

Note: if `getUserProfile`'s return type does not already include an optional `caps`, the `as never` casts in `snapshot` keep TypeScript happy without widening the shared `UserProfile` type; the runtime shape is `{ id, firstName?, lastName?, username?, caps }`.

- [ ] **Step 4: Register in `routes/index.ts`**

Add the import and spread it into `ROUTES`:

```ts
import { collaboratorRoutes } from './collaborators'
// ...
export const ROUTES: Route[] = [...stateRoutes, ...chatRoutes, ...botRoutes, ...gitRoutes, ...agentTestRoutes, ...userRoutes, ...metricsRoutes, ...healthRoutes, ...collaboratorRoutes]
```

- [ ] **Step 5: Run the test; expect pass**

Run: `npx vitest run src/main/core/__tests__/miniapp.collaborators.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck + commit (local)**

Run: `npm run typecheck`
Then:
```bash
git add src/main/core/miniapp/routes/collaborators.ts src/main/core/miniapp/routes/index.ts src/main/core/__tests__/miniapp.collaborators.test.ts
git commit -m "feat(collab): owner/host-only collaborator CRUD routes"
```

---

### Task 3: Secret reveal in getEnv (viewSecrets)

**Files:**
- Modify: `src/main/core/miniapp/routes/state.ts`
- Test: `src/main/core/__tests__/miniapp.env-reveal.test.ts` (create)

**Interfaces:**
- Consumes: `auth`; `can` (authz), `findEntry` (registry); existing `sup.getEnv`, `SECRET_KEY_RE`.
- Produces: `getEnv` returns unmasked secret values only when the requester has `viewSecrets`.

- [ ] **Step 1: Write the failing test**

Create `src/main/core/__tests__/miniapp.env-reveal.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('../supervisor', () => ({
  getEnv: () => ({ keys: ['NAME', 'API_TOKEN'], current: { NAME: 'bot', API_TOKEN: 'secret-123' } })
}))
// a: owner 7, collaborator 2 has viewSecrets; collaborator 3 has editEnv only
vi.mock('../registry', () => ({
  findEntry: () => ({ id: 'a', ownerId: 7, collaborators: { '2': { editEnv: true, viewSecrets: true }, '3': { editEnv: true } } })
}))
vi.mock('../../telegramBot', () => ({ tailBotLogs: () => '' }))
vi.mock('../../config', () => ({ getAppConfig: () => ({}), setAutoApprove: () => {}, setAutoUpdateEnabled: () => {}, setNotifyConfig: () => {}, setAgentConfig: () => {} }))

import { stateRoutes } from '../miniapp/routes/state'

function getEnv(auth: { userId: number; isOwner: boolean }) {
  const json = vi.fn()
  const route = stateRoutes.find((r) => r.path === '/api/env' && r.method === 'GET')!
  route.handler({ auth, json, url: new URL('http://x/api/env?id=a'), body: {} } as never)
  return json.mock.calls[0][1] as { current: Record<string, string>; secretKeys: string[] }
}

describe('env secret reveal', () => {
  it('reveals secrets to a viewSecrets collaborator', () => {
    const p = getEnv({ userId: 2, isOwner: false })
    expect(p.current.API_TOKEN).toBe('secret-123')
    expect(p.current.NAME).toBe('bot')
  })
  it('masks secrets for an editEnv-only collaborator', () => {
    const p = getEnv({ userId: 3, isOwner: false })
    expect(p.current.API_TOKEN).toBe('')
    expect(p.secretKeys).toContain('API_TOKEN')
  })
  it('reveals secrets to the host', () => {
    expect(getEnv({ userId: 1, isOwner: true }).current.API_TOKEN).toBe('secret-123')
  })
})
```

- [ ] **Step 2: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/miniapp.env-reveal.test.ts`
Expected: FAIL (secrets currently always masked → `API_TOKEN` is `''` even for uid 2/host).

- [ ] **Step 3: Implement in `state.ts`**

Update the import line `import { botsVisibleTo, assertCap } from '../authz'` to also import `can`:

```ts
import { botsVisibleTo, assertCap, can } from '../authz'
import { findEntry } from '../../registry'
```

In `getEnv`, after the existing `assertCap(..., 'editEnv')` line, compute reveal and use it in the masking loop:

```ts
  const reveal = can(c.auth.userId, c.auth.isOwner, findEntry(id), 'viewSecrets')
  for (const k of env.keys) {
    const isSecret = SECRET_KEY_RE.test(k)
    if (isSecret) secretKeys.push(k)
    current[k] = isSecret ? (reveal ? (env.current[k] ?? '') : '') : (env.current[k] ?? '')
  }
```

(Leave the `hasValue` loop and the `assertCap(..., 'editEnv')` gate unchanged.)

- [ ] **Step 4: Run the test; expect pass**

Run: `npx vitest run src/main/core/__tests__/miniapp.env-reveal.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit (local)**

```bash
git add src/main/core/miniapp/routes/state.ts src/main/core/__tests__/miniapp.env-reveal.test.ts
git commit -m "feat(collab): reveal env secrets to viewSecrets-capable requesters"
```

---

### Task 4: Control bot → owned-only

**Files:**
- Modify: `src/main/core/telegramBot.ts`
- Test: `src/main/core/__tests__/telegramBot.tenancy.test.ts` (modify existing)

**Interfaces:**
- Consumes: `findEntry` (already imported in telegramBot), `auth`/`isOwner` flags.
- Produces: control bot lists/resolves only bots the user OWNS (host still sees all). Collaborated bots are not reachable via the control bot this phase.

- [ ] **Step 1: Update the test to assert owned-only**

In `src/main/core/__tests__/telegramBot.tenancy.test.ts`, the registry mock already exposes bots `a` (owner 7) and `b` (owner 1). Add a collaborator to `b` for uid 7 in the mock's `readRegistry`/`findEntry` (e.g. `b` → `{ id:'b', ownerId:1, collaborators:{ '7': { viewLogs:true } } }`), then change the helper under test from `filterVisible` to `filterOwned` and assert: tenant 7 sees only `a` (NOT `b`, despite collaborating), host sees both. Replace the existing two `filterVisible` cases with:

```ts
import { filterOwned } from '../telegramBot'
const bots = [{ manifest: { id: 'a' } }, { manifest: { id: 'b' } }]
it('control bot shows a tenant only OWNED bots (not collaborated)', () => {
  expect(filterOwned(bots, 7, false).map((b) => b.manifest.id)).toEqual(['a'])
})
it('host sees all bots', () => {
  expect(filterOwned(bots, 1, true).map((b) => b.manifest.id).sort()).toEqual(['a', 'b'])
})
```

- [ ] **Step 2: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/telegramBot.tenancy.test.ts`
Expected: FAIL (`filterOwned` not exported).

- [ ] **Step 3: Implement in `telegramBot.ts`**

Replace the exported `filterVisible` helper (currently using `botsVisibleTo`) with an owned-only `filterOwned`:

```ts
export function filterOwned<T extends { manifest: { id: string } }>(bots: T[], uid: number, isHost: boolean): T[] {
  if (isHost) return bots
  return bots.filter((b) => findEntry(b.manifest.id)?.ownerId === uid)
}
```

Update `visibleBots` to use it:

```ts
  private async visibleBots(chatId: number, isOwner: boolean): Promise<Bot[]> {
    return filterOwned(await sup.listBots(), chatId, isOwner)
  }
```

Replace any other `filterVisible(...)` call sites in `telegramBot.ts` (e.g. in `runAgentSession`) with `filterOwned(...)`. Then remove the now-unused `botsVisibleTo` from the `./miniapp/authz` import (keep `can`, still used by `startAgentForBot`). Verify with `grep -n "filterVisible\|botsVisibleTo" src/main/core/telegramBot.ts` returning nothing.

- [ ] **Step 4: Run tests; expect pass**

Run: `npx vitest run src/main/core/__tests__/telegramBot.tenancy.test.ts && npm run typecheck`
Expected: tests PASS; typecheck clean.

- [ ] **Step 5: Commit (local)**

```bash
git add src/main/core/telegramBot.ts src/main/core/__tests__/telegramBot.tenancy.test.ts
git commit -m "feat(collab): control bot scoped to owned bots only (collab is Mini-App-only)"
```

---

### Task 5: Collaborators UI + secret reveal affordance (fleet.ts)

**Files:**
- Modify: `src/main/core/miniapp/frontend/views/fleet.ts`
- Verify: `npm run build` + `npm test`

**Interfaces:**
- Consumes: the Task 2 endpoints (`/api/bots/collaborators` GET/POST and `/remove`) and the Task 3 `getEnv` reveal (secret `current[k]` is non-empty when revealable).

- [ ] **Step 1: Read `fleet.ts` fully**

Run: `sed -n '1,200p' src/main/core/miniapp/frontend/views/fleet.ts`
Locate the bot-detail render path (where it renders env/actions/logs for a single bot) and how it issues fetches (the existing `App` helper / fetch pattern) and how it knows the viewer is the owner (the `owner`/`st.owner` signal). Match that exact embedded-JS style.

- [ ] **Step 2: Implement the Collaborators card (owner-only)**

In the bot-detail render, when the viewer owns the bot (or is host), append a "Collaborators" card built with single-quoted string concatenation (NO backticks/`${}`):
- On open, fetch `GET /api/bots/collaborators?botId=<id>` and render: each current collaborator (name/@handle from the profile fields) with six labeled toggle switches reflecting `caps`; an "Add collaborator" picker populated from `addable`; and a remove (x) per row.
- Flipping a toggle posts `POST /api/bots/collaborators` with `{ botId, userId, capabilities: <full six-key object> }` (send the complete current toggle state for that user, not a partial).
- Selecting a tenant from the picker posts the same with all toggles false.
- Remove posts `POST /api/bots/collaborators/remove` with `{ botId, userId }`.
- After any mutation, re-fetch and re-render the card.
- For the env editor: when a secret key's returned `current[k]` is non-empty (the API revealed it because the viewer has `viewSecrets`), show the value with a reveal/show affordance; when it is empty but listed in `secretKeys`, keep the masked placeholder as today.

Keep all additions inside the existing embedded-JS string concatenation; do not introduce template literals.

- [ ] **Step 3: Build + full suite**

Run: `npm run build && npm test`
Expected: build succeeds (a stray backtick/`${}` fails here); 152+ tests pass / 2 skip, no regressions.

- [ ] **Step 4: Commit (local)**

```bash
git add src/main/core/miniapp/frontend/views/fleet.ts
git commit -m "feat(collab): Collaborators card + secret reveal affordance in bot detail"
```

---

### Final verification (after all tasks)

- [ ] `npm run typecheck` → clean
- [ ] `npm test` → all green (Phase 1 + Phase 2 tests; 2 pre-existing skips remain)
- [ ] `npm run build` → succeeds
- [ ] Manual smoke: as owner, open a bot → add an approved tenant as collaborator with `viewLogs` only → that tenant (Mini App) sees the bot, can read logs, but `/api/action` and `/api/env` return 403; grant `editEnv`+`viewSecrets` → they can edit env and see secret plaintext; the collaborated bot does NOT appear in that tenant's Telegram control-bot `/list`.

---

## Notes for the executor

- The `can()` chokepoint and per-capability route gating (`logs→viewLogs`, `env→editEnv`, `action→startStop`) already exist from Phase 1 — Task 3 only adds the `viewSecrets` reveal branch; no other enforcement changes are needed.
- `viewSecrets` reveal sends plaintext secrets to the client over the tunnel — this is the owner-granted tradeoff documented in the spec; do not add it to any endpoint other than `getEnv`.
- Managing collaborators is owner/host-only and is NOT a delegable capability.
