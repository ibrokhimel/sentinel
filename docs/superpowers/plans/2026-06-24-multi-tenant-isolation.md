# Multi-Tenant Isolation (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every approved Telegram user their own isolated Sentinel workspace — they see and control only the bots they own; the host (you) sees and controls everything.

**Architecture:** Add `ownerId` + `collaborators` to each registry entry, derive the host uid from the existing control `ownerChatId`, and route every bot-scoped read/action through one pure authorization function `can()` in a new `authz.ts`. Mini App routes and the control bot filter their bot lists through `botsVisibleTo()`; mutations assert capability via `assertCap()` which throws `ForbiddenError` → HTTP 403. Collaboration UI is Phase 2; this phase ships owner-only isolation.

**Tech Stack:** TypeScript (Node ESM), Vitest, Electron main process. JSON file stores at `SENTINEL_HOME/config.json` and `SENTINEL_HOME/registry.json`.

## Global Constraints

- Do NOT modify these dirty files: `src/main/core/__tests__/integration.launchd.test.ts`, `src/main/core/launchctl.ts`, `src/main/core/monitor.ts`.
- Any new persisted config field MUST be carried through `readStored()` in `config.ts` — the whitelist-reconstruction there silently drops unlisted keys (this was the live approval bug). Every config task includes a round-trip persistence test.
- In embedded frontend view strings (`miniapp/frontend/**`), do NOT use backtick template literals or `${}` inside the embedded JS strings.
- Identity is already verified upstream: `RouteCtx.auth = { userId: number; isOwner: boolean }` (`miniapp/service.ts:173`). `isOwner` means "is the host." Never re-derive identity in a handler; trust `auth`.
- Host uid derives from `getControlConfig().ownerChatId` (which is `notify.chatId`).
- Default-deny: `can()` returns `false` unless a rule explicitly allows.
- Commits in this plan are LOCAL ONLY. Do not push, tag, or release. Do not expose secrets.
- Tests use in-memory `node:fs` mocks (see `__tests__/config.access.test.ts` for the established pattern) or `SENTINEL_DATA_HOME` overrides — never touch the real `~/Documents/Sentinel` files.
- Run the full suite with `npm test`; typecheck with `npm run typecheck`.

---

### Task 1: Host identity + tenant limits (config)

**Files:**
- Modify: `src/main/core/config.ts`
- Test: `src/main/core/__tests__/config.tenancy.test.ts` (create)

**Interfaces:**
- Consumes: existing `readStored()`, `writeStored()`, `getControlConfig()`.
- Produces:
  - `getHostUid(): number | null`
  - `interface TenantLimits { maxBotsPerTenant: number; aiPerDay: { chat: number; ask: number; fix: number } }`
  - `getLimits(): TenantLimits`
  - `setLimits(patch: Partial<TenantLimits>): void`

- [ ] **Step 1: Write the failing test**

Create `src/main/core/__tests__/config.tenancy.test.ts`:

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

import { getHostUid, getLimits, setLimits, setNotifyConfig } from '../config'

describe('tenancy config', () => {
  beforeEach(() => files.clear())

  it('derives host uid from the control owner chat id', () => {
    expect(getHostUid()).toBeNull() // unset
    setNotifyConfig({ chatId: '8683512953' })
    expect(getHostUid()).toBe(8683512953)
  })

  it('returns default limits and persists overrides across reads', () => {
    expect(getLimits().maxBotsPerTenant).toBe(5)
    setLimits({ maxBotsPerTenant: 9 })
    expect(getLimits().maxBotsPerTenant).toBe(9) // survives readStored round-trip
    expect(getLimits().aiPerDay.fix).toBe(1)
  })
})
```

- [ ] **Step 2: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/config.tenancy.test.ts`
Expected: FAIL (`getHostUid` / `getLimits` / `setLimits` not exported). Note: confirm `setNotifyConfig` exists with a `{ chatId }` patch (it does, `config.ts` ~line 216); if its name differs, import the actual notify setter.

- [ ] **Step 3: Implement in `config.ts`**

Add to the `StoredConfig` interface (after `backgroundAgent`):

```ts
  limits?: {
    maxBotsPerTenant: number
    aiPerDay: { chat: number; ask: number; fix: number }
  }
```

Add to `readStored()`'s returned object (alongside the access-control carry-through added earlier):

```ts
      limits: parsed.limits ?? {
        maxBotsPerTenant: 5,
        aiPerDay: { chat: 30, ask: 20, fix: 1 }
      },
```

Add exported functions (near the approved-users block):

```ts
export interface TenantLimits {
  maxBotsPerTenant: number
  aiPerDay: { chat: number; ask: number; fix: number }
}

/** The host/super-admin Telegram uid, derived from the control owner chat id. */
export function getHostUid(): number | null {
  const raw = getControlConfig().ownerChatId.trim()
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function getLimits(): TenantLimits {
  const c = readStored()
  return c.limits ?? { maxBotsPerTenant: 5, aiPerDay: { chat: 30, ask: 20, fix: 1 } }
}

export function setLimits(patch: Partial<TenantLimits>): void {
  const c = readStored()
  const cur = c.limits ?? { maxBotsPerTenant: 5, aiPerDay: { chat: 30, ask: 20, fix: 1 } }
  c.limits = { ...cur, ...patch }
  writeStored(c)
}
```

- [ ] **Step 4: Run the test; expect pass**

Run: `npx vitest run src/main/core/__tests__/config.tenancy.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit (local)**

```bash
git add src/main/core/config.ts src/main/core/__tests__/config.tenancy.test.ts
git commit -m "feat(tenancy): host uid + per-tenant limits in config"
```

---

### Task 2: Registry ownership model, migration & helpers

**Files:**
- Modify: `src/main/core/registry.ts`
- Test: `src/main/core/__tests__/registry.ownership.test.ts` (create)

**Interfaces:**
- Consumes: `getHostUid()` from Task 1; existing `readRegistry()`, `writeRegistry()`, `findEntry()`.
- Produces:
  - `interface Capabilities { viewLogs?: boolean; chat?: boolean; startStop?: boolean; deploy?: boolean; editEnv?: boolean; viewSecrets?: boolean }`
  - extended `RegistryEntry` with `ownerId?: number` and `collaborators?: Record<string, Capabilities>`
  - `setBotOwner(id: string, ownerId: number): void`
  - `botsOwnedBy(uid: number): RegistryEntry[]`

- [ ] **Step 1: Write the failing test**

Create `src/main/core/__tests__/registry.ownership.test.ts`:

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
vi.mock('../config', () => ({ getHostUid: () => 1000 }))

import { REGISTRY_PATH } from '../paths'
import { readRegistry, setBotOwner, botsOwnedBy } from '../registry'

describe('registry ownership', () => {
  beforeEach(() => files.clear())

  it('migrates unowned entries to the host uid (idempotent)', () => {
    files.set(REGISTRY_PATH, JSON.stringify([{ id: 'a', name: 'A', dirName: 'a' }]))
    expect(readRegistry()[0].ownerId).toBe(1000)
    const afterFirst = files.get(REGISTRY_PATH)
    readRegistry() // second read must NOT rewrite (already stamped)
    expect(files.get(REGISTRY_PATH)).toBe(afterFirst)
  })

  it('setBotOwner assigns ownership and botsOwnedBy filters by uid', () => {
    files.set(REGISTRY_PATH, JSON.stringify([
      { id: 'a', name: 'A', dirName: 'a', ownerId: 1000 },
      { id: 'b', name: 'B', dirName: 'b', ownerId: 1000 }
    ]))
    setBotOwner('b', 2000)
    expect(botsOwnedBy(2000).map((e) => e.id)).toEqual(['b'])
    expect(botsOwnedBy(1000).map((e) => e.id)).toEqual(['a'])
  })
})
```

- [ ] **Step 2: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/registry.ownership.test.ts`
Expected: FAIL (`ownerId` undefined; `setBotOwner`/`botsOwnedBy` not exported).

- [ ] **Step 3: Implement in `registry.ts`**

Add import at top: `import { getHostUid } from './config'`.

Replace the `RegistryEntry` interface:

```ts
export interface Capabilities {
  viewLogs?: boolean
  chat?: boolean
  startStop?: boolean
  deploy?: boolean
  editEnv?: boolean
  viewSecrets?: boolean
}

export interface RegistryEntry {
  id: string
  name: string
  /** Directory name under bots/. */
  dirName: string
  /** Telegram uid of the owning tenant (host on migration). */
  ownerId?: number
  /** uid → granular per-bot capabilities (Phase 2 populates this). */
  collaborators?: Record<string, Capabilities>
}
```

Replace `readRegistry()` with a migrating version:

```ts
export function readRegistry(): RegistryEntry[] {
  if (!existsSync(REGISTRY_PATH)) return []
  let entries: RegistryEntry[]
  try {
    entries = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as RegistryEntry[]
  } catch {
    return []
  }
  const host = getHostUid()
  let changed = false
  if (host !== null) {
    for (const e of entries) {
      if (e.ownerId == null) {
        e.ownerId = host
        changed = true
      }
    }
  }
  if (changed) writeRegistry(entries)
  return entries
}
```

Add helpers (after `findEntry`):

```ts
export function setBotOwner(id: string, ownerId: number): void {
  const entries = readRegistry()
  const e = entries.find((x) => x.id === id)
  if (!e) return
  e.ownerId = ownerId
  writeRegistry(entries)
}

export function botsOwnedBy(uid: number): RegistryEntry[] {
  return readRegistry().filter((e) => e.ownerId === uid)
}
```

- [ ] **Step 4: Run the test; expect pass**

Run: `npx vitest run src/main/core/__tests__/registry.ownership.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit (local)**

```bash
git add src/main/core/registry.ts src/main/core/__tests__/registry.ownership.test.ts
git commit -m "feat(tenancy): registry ownerId model + host migration"
```

---

### Task 3: Authorization chokepoint (`authz.ts`) + 403 wiring

**Files:**
- Create: `src/main/core/miniapp/authz.ts`
- Modify: `src/main/core/miniapp/service.ts` (catch `ForbiddenError` → 403)
- Test: `src/main/core/__tests__/authz.test.ts` (create)

**Interfaces:**
- Consumes: `RegistryEntry`, `Capabilities` (Task 2); `readRegistry`, `findEntry`.
- Produces:
  - `type Capability = 'view' | 'viewLogs' | 'chat' | 'startStop' | 'deploy' | 'editEnv' | 'viewSecrets'`
  - `class ForbiddenError extends Error`
  - `can(uid: number, isHost: boolean, entry: RegistryEntry | undefined, cap: Capability): boolean`
  - `botsVisibleTo(uid: number, isHost: boolean): RegistryEntry[]`
  - `assertCap(uid: number, isHost: boolean, botId: string, cap: Capability): RegistryEntry` (throws `ForbiddenError` on deny; returns the entry on allow)

- [ ] **Step 1: Write the failing test**

Create `src/main/core/__tests__/authz.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { can, ForbiddenError, assertCap } from '../miniapp/authz'
import type { RegistryEntry } from '../registry'

const owned = (uid: number): RegistryEntry => ({ id: 'b', name: 'B', dirName: 'b', ownerId: uid })
const withCollab = (caps: Record<string, boolean>): RegistryEntry => ({
  id: 'b', name: 'B', dirName: 'b', ownerId: 1, collaborators: { '2': caps as never }
})

describe('can() truth table', () => {
  it('host can do everything, even on an unknown bot', () => {
    expect(can(999, true, undefined, 'editEnv')).toBe(true)
    expect(can(999, true, owned(1), 'viewSecrets')).toBe(true)
  })
  it('owner can do everything on their bot', () => {
    expect(can(1, false, owned(1), 'editEnv')).toBe(true)
    expect(can(1, false, owned(1), 'viewSecrets')).toBe(true)
  })
  it('stranger is denied all, including view', () => {
    for (const cap of ['view', 'viewLogs', 'chat', 'startStop', 'deploy', 'editEnv', 'viewSecrets'] as const) {
      expect(can(3, false, owned(1), cap)).toBe(false)
    }
  })
  it('collaborator: view always allowed; other caps follow the toggle', () => {
    expect(can(2, false, withCollab({ viewLogs: true }), 'view')).toBe(true)
    expect(can(2, false, withCollab({ viewLogs: true }), 'viewLogs')).toBe(true)
    expect(can(2, false, withCollab({ viewLogs: true }), 'editEnv')).toBe(false)
  })
  it('collaborator can never remove/manage (no such cap grants it)', () => {
    // remove is gated at the route as owner/host-only; collaborators have no editEnv by default
    expect(can(2, false, withCollab({}), 'editEnv')).toBe(false)
  })
  it('unknown bot for non-host is denied', () => {
    expect(can(2, false, undefined, 'view')).toBe(false)
  })
})

describe('assertCap', () => {
  it('throws ForbiddenError for a denied capability', () => {
    expect(() => assertCap(3, false, 'nope', 'view')).toThrow(ForbiddenError)
  })
})
```

- [ ] **Step 2: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/authz.test.ts`
Expected: FAIL (module `../miniapp/authz` not found).

- [ ] **Step 3: Implement `authz.ts`**

Create `src/main/core/miniapp/authz.ts`:

```ts
/**
 * authz.ts — the single authorization chokepoint for bot-scoped access.
 * Pure decision logic (`can`) plus registry-backed helpers. Default-deny.
 */
import { readRegistry, findEntry, type RegistryEntry, type Capabilities } from '../registry'

export type Capability =
  | 'view' | 'viewLogs' | 'chat' | 'startStop' | 'deploy' | 'editEnv' | 'viewSecrets'

export class ForbiddenError extends Error {
  constructor(msg = 'forbidden') {
    super(msg)
    this.name = 'ForbiddenError'
  }
}

/** Pure: may `uid` perform `cap` on `entry`? Host and owner → all; collaborator → toggle. */
export function can(
  uid: number,
  isHost: boolean,
  entry: RegistryEntry | undefined,
  cap: Capability
): boolean {
  if (isHost) return true
  if (!entry) return false
  if (entry.ownerId === uid) return true
  const caps: Capabilities | undefined = entry.collaborators?.[String(uid)]
  if (!caps) return false
  if (cap === 'view') return true
  return caps[cap] === true
}

/** All registry entries the caller may at least see. */
export function botsVisibleTo(uid: number, isHost: boolean): RegistryEntry[] {
  return readRegistry().filter((e) => can(uid, isHost, e, 'view'))
}

/** Throw ForbiddenError unless allowed; return the entry when allowed. */
export function assertCap(uid: number, isHost: boolean, botId: string, cap: Capability): RegistryEntry {
  const entry = findEntry(botId)
  if (!can(uid, isHost, entry, cap)) throw new ForbiddenError()
  return entry as RegistryEntry
}
```

- [ ] **Step 4: Run the test; expect pass**

Run: `npx vitest run src/main/core/__tests__/authz.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire ForbiddenError → 403 in `service.ts`**

In `service.ts`, add the import near the top:

```ts
import { ForbiddenError } from './authz'
```

Replace the handler-dispatch tail of `api()` (currently `return await route.handler(ctx)`) with:

```ts
    try {
      return await route.handler(ctx)
    } catch (e) {
      if (e instanceof ForbiddenError) return this.json(res, 403, { error: 'forbidden' })
      throw e
    }
```

- [ ] **Step 6: Typecheck + full test run**

Run: `npm run typecheck && npx vitest run src/main/core/__tests__/authz.test.ts`
Expected: typecheck clean; authz tests PASS.

- [ ] **Step 7: Commit (local)**

```bash
git add src/main/core/miniapp/authz.ts src/main/core/miniapp/service.ts src/main/core/__tests__/authz.test.ts
git commit -m "feat(tenancy): authz chokepoint (can/botsVisibleTo/assertCap) + 403 wiring"
```

---

### Task 4: Bot import quota + owner stamping + remove guard

**Files:**
- Modify: `src/main/core/miniapp/routes/bots.ts`
- Test: `src/main/core/__tests__/miniapp.bots.tenancy.test.ts` (create)

**Interfaces:**
- Consumes: `auth: { userId, isOwner }`; `getLimits()` (Task 1); `botsOwnedBy`, `setBotOwner`, `findEntry` (Task 2); `assertCap`, `ForbiddenError` (Task 3); `sup.importBot`, `sup.removeBot`.
- Produces: tenancy-aware `importBot`/`removeBot` handlers; `bots.ts` routes change `ownerOnly` from `true` to `false` for import/remove (authorization now per-tenant inside the handler).

- [ ] **Step 1: Write the failing test**

Create `src/main/core/__tests__/miniapp.bots.tenancy.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock paths resolve relative to THIS test file (src/main/core/__tests__/),
// so '../supervisor' === the module bots.ts imports as '../../supervisor'.
vi.mock('../supervisor', () => ({
  importBot: vi.fn(async () => ({ bot: { manifest: { id: 'newbot' } } })),
  removeBot: vi.fn(async () => undefined)
}))
const owned = vi.fn<[], unknown[]>(() => [])
vi.mock('../registry', () => ({
  botsOwnedBy: (uid: number) => owned(),
  setBotOwner: vi.fn(),
  findEntry: (id: string) => (id === 'mine' ? { id, ownerId: 7 } : { id, ownerId: 999 })
}))
vi.mock('../config', () => ({ getLimits: () => ({ maxBotsPerTenant: 2, aiPerDay: { chat: 1, ask: 1, fix: 1 } }) }))

import { botRoutes } from '../miniapp/routes/bots'

function run(path: string, body: unknown, auth: { userId: number; isOwner: boolean }) {
  const json = vi.fn()
  const route = botRoutes.find((r) => r.path === path)!
  return { p: route.handler({ body, json, auth } as never), json }
}

describe('bots tenancy', () => {
  beforeEach(() => owned.mockReturnValue([]))

  it('blocks a tenant who is at their bot quota', async () => {
    owned.mockReturnValue([{}, {}]) // 2 == maxBotsPerTenant
    const { p, json } = run('/api/bots/import', { url: 'https://x/y.git' }, { userId: 7, isOwner: false })
    await p
    expect(json).toHaveBeenCalledWith(403, expect.objectContaining({ error: expect.stringMatching(/limit/i) }))
  })

  it('lets a tenant import below quota and stamps ownership', async () => {
    const { p, json } = run('/api/bots/import', { url: 'https://x/y.git' }, { userId: 7, isOwner: false })
    await p
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ ok: true, id: 'newbot' }))
  })

  it('forbids removing a bot the tenant does not own', async () => {
    const { p, json } = run('/api/bots/remove', { id: 'notmine', confirm: true }, { userId: 7, isOwner: false })
    await p
    expect(json).toHaveBeenCalledWith(403, expect.objectContaining({ error: expect.any(String) }))
  })
})
```

- [ ] **Step 2: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/miniapp.bots.tenancy.test.ts`
Expected: FAIL (handlers not yet quota/owner-aware: the quota and remove-guard assertions fail).

- [ ] **Step 3: Implement in `bots.ts`**

Add imports:

```ts
import { getLimits } from '../../config'
import { botsOwnedBy, setBotOwner, findEntry } from '../../registry'
```

Replace `importBot`:

```ts
async function importBot(c: RouteCtx): Promise<void> {
  const url = String((c.body as Record<string, unknown>).url ?? '').trim()
  if (!/^https?:\/\//.test(url)) {
    c.json(400, { error: 'provide a valid http(s) git URL' })
    return
  }
  // Per-tenant bot quota (host is unlimited).
  if (!c.auth.isOwner) {
    const owned = botsOwnedBy(c.auth.userId).length
    if (owned >= getLimits().maxBotsPerTenant) {
      c.json(403, { error: 'bot limit reached for your account' })
      return
    }
  }
  try {
    const { bot } = await sup.importBot({ type: 'git', source: url })
    setBotOwner(bot.manifest.id, c.auth.userId) // stamp the importing tenant as owner
    c.json(200, { ok: true, id: bot.manifest.id })
  } catch (e) {
    c.json(500, { error: String((e as Error)?.message ?? e) })
  }
}
```

Replace `removeBot`:

```ts
async function removeBot(c: RouteCtx): Promise<void> {
  const b = c.body as { id?: string; confirm?: boolean }
  if (b.confirm !== true) {
    c.json(400, { error: 'confirm required' })
    return
  }
  // Owner/host only — collaborators can never remove a bot.
  const entry = findEntry(String(b.id))
  if (!c.auth.isOwner && entry?.ownerId !== c.auth.userId) {
    c.json(403, { error: 'only the bot owner can remove it' })
    return
  }
  try {
    await sup.removeBot(String(b.id))
    c.json(200, { ok: true })
  } catch (e) {
    c.json(500, { error: String((e as Error)?.message ?? e) })
  }
}
```

Change the route table so tenants reach these handlers (authorization is now inside):

```ts
export const botRoutes: Route[] = [
  { method: 'POST', path: '/api/bots/import', ownerOnly: false, handler: importBot },
  { method: 'POST', path: '/api/bots/remove', ownerOnly: false, handler: removeBot },
  { method: 'POST', path: '/api/bots/upload', ownerOnly: false, handler: uploadBot },
]
```

(The remove guard uses an explicit owner check rather than `assertCap`, because remove must be owner/host-only and no collaborator capability ever grants it.)

- [ ] **Step 4: Run the test; expect pass**

Run: `npx vitest run src/main/core/__tests__/miniapp.bots.tenancy.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit (local)**

```bash
git add src/main/core/miniapp/routes/bots.ts src/main/core/__tests__/miniapp.bots.tenancy.test.ts
git commit -m "feat(tenancy): per-tenant bot quota, owner stamping, owner-only remove"
```

---

### Task 5: Visibility filtering on state/metrics + settings split

**Files:**
- Modify: `src/main/core/miniapp/routes/state.ts`
- Modify: `src/main/core/miniapp/routes/metrics.ts`
- Test: `src/main/core/__tests__/miniapp.state.tenancy.test.ts` (create)

**Interfaces:**
- Consumes: `auth`; `botsVisibleTo` (Task 3); existing `sup.listBots()`.
- Produces: every bot list returned by state/metrics is filtered to `botsVisibleTo(auth.userId, auth.isOwner)`; host-only settings sections present only when `auth.isOwner`.

- [ ] **Step 1: Read the two route files to find each place a full bot list is returned**

Run: `sed -n '1,200p' src/main/core/miniapp/routes/state.ts` and `sed -n '1,200p' src/main/core/miniapp/routes/metrics.ts`
Identify every `sup.listBots()` (or equivalent) call and any settings payload assembled for the UI.

- [ ] **Step 2: Write the failing test**

Create `src/main/core/__tests__/miniapp.state.tenancy.test.ts`. Mock `sup.listBots()` to return two bots owned by different uids and `botsVisibleTo` via the real registry mock, then assert a tenant sees only theirs and the host sees both. Use this skeleton, adapting the imported route name to the actual handler that returns the bot list (found in Step 1):

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('../supervisor', () => ({
  listBots: vi.fn(async () => [
    { manifest: { id: 'a' }, state: 'running' },
    { manifest: { id: 'b' }, state: 'running' }
  ])
}))
vi.mock('../registry', () => ({
  // a → tenant 7, b → host 1
  readRegistry: () => [
    { id: 'a', name: 'A', dirName: 'a', ownerId: 7 },
    { id: 'b', name: 'B', dirName: 'b', ownerId: 1 }
  ],
  findEntry: (id: string) => ({ a: { id: 'a', ownerId: 7 }, b: { id: 'b', ownerId: 1 } } as never)[id]
}))

import { stateRoutes } from '../miniapp/routes/state'

async function call(path: string, auth: { userId: number; isOwner: boolean }) {
  const json = vi.fn()
  const route = stateRoutes.find((r) => r.path === path)!
  await route.handler({ auth, body: {}, json, url: new URL('http://x' + path) } as never)
  return json
}

describe('state visibility filtering', () => {
  it('tenant sees only owned bots', async () => {
    const json = await call('/api/state', { userId: 7, isOwner: false }) // adjust path to the real list endpoint
    const payload = json.mock.calls[0][1] as { bots: { id: string }[] }
    expect(payload.bots.map((b) => b.id)).toEqual(['a'])
  })
  it('host sees all bots', async () => {
    const json = await call('/api/state', { userId: 1, isOwner: true })
    const payload = json.mock.calls[0][1] as { bots: { id: string }[] }
    expect(payload.bots.map((b) => b.id).sort()).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 3: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/miniapp.state.tenancy.test.ts`
Expected: FAIL (tenant currently sees both bots).

- [ ] **Step 4: Implement filtering**

In `state.ts` (and `metrics.ts`), import:

```ts
import { botsVisibleTo } from '../authz'
```

At each point a full bot list is built for the response, intersect by visible ids:

```ts
const visibleIds = new Set(botsVisibleTo(c.auth.userId, c.auth.isOwner).map((e) => e.id))
const bots = (await sup.listBots()).filter((b) => visibleIds.has(b.manifest.id))
```

For any settings/config block in `state.ts` intended for the host only (notifier token, auto-update, maintenance, AI provider key, limits), guard it:

```ts
if (c.auth.isOwner) {
  payload.settings = { /* existing host settings assembly */ }
}
// tenants: omit host settings entirely (do not send them and gate client-side later)
```

- [ ] **Step 5: Run the test; expect pass**

Run: `npx vitest run src/main/core/__tests__/miniapp.state.tenancy.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit (local)**

```bash
git add src/main/core/miniapp/routes/state.ts src/main/core/miniapp/routes/metrics.ts src/main/core/__tests__/miniapp.state.tenancy.test.ts
git commit -m "feat(tenancy): filter state/metrics bot lists by visibility; host-only settings"
```

---

### Task 6: Per-tenant chat session scoping

**Files:**
- Modify: `src/main/core/miniapp/sessions.ts`
- Modify: `src/main/core/miniapp/routes/chat.ts`
- Test: `src/main/core/__tests__/miniapp.sessions.tenancy.test.ts` (create)

**Interfaces:**
- Consumes: `auth`; `botsVisibleTo` (Task 3).
- Produces:
  - `ChatSession` gains `ownerId?: number`.
  - Per-uid main session id: `mainIdFor(uid: number): string` → `'main:' + uid`.
  - `listSessions(uid: number, botId?: string | null): ChatSession[]` (uid-scoped).
  - `getSessionFor(uid: number, id: string): ChatSession | null` (returns null if the session's `ownerId` ≠ uid).
  - `createSession` accepts `ownerId`.
  - chat handlers: fleet (`chat`) scope limited to caller's visible bots; `ask` requires the target bot be visible.

- [ ] **Step 1: Write the failing test**

Create `src/main/core/__tests__/miniapp.sessions.tenancy.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

beforeEach(() => {
  process.env.SENTINEL_DATA_HOME = mkdtempSync(join(tmpdir(), 'sent-sess-'))
})

import { createSession, listSessions, getSessionFor, mainIdFor } from '../miniapp/sessions'

describe('session tenancy', () => {
  it('scopes sessions to their owner', () => {
    const s7 = createSession({ ownerId: 7, botId: 'a', mode: 'ask', title: 't7' })
    createSession({ ownerId: 8, botId: 'b', mode: 'ask', title: 't8' })
    expect(listSessions(7).map((s) => s.title)).toContain('t7')
    expect(listSessions(7).map((s) => s.title)).not.toContain('t8')
    expect(getSessionFor(8, s7.id)).toBeNull() // cannot read another tenant's session
    expect(getSessionFor(7, s7.id)?.title).toBe('t7')
  })
  it('gives each tenant a distinct main id', () => {
    expect(mainIdFor(7)).not.toBe(mainIdFor(8))
  })
})
```

- [ ] **Step 2: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/miniapp.sessions.tenancy.test.ts`
Expected: FAIL (`mainIdFor`/`getSessionFor` not exported; `createSession` lacks `ownerId`).

- [ ] **Step 3: Implement in `sessions.ts`**

Add `ownerId?: number` to `ChatSession`. Add:

```ts
export function mainIdFor(uid: number): string {
  return 'main:' + uid
}

function mkMainFor(uid: number): ChatSession {
  const t = Date.now()
  return { id: mainIdFor(uid), title: 'Main', botId: null, mode: 'chat', messages: [], createdAt: t, updatedAt: t, ownerId: uid }
}

export function getSessionFor(uid: number, id: string): ChatSession | null {
  const s = load()[id] ?? null
  if (!s) return null
  if (s.ownerId != null && s.ownerId !== uid) return null
  return s
}
```

Change `createSession` to accept and store `ownerId`:

```ts
export function createSession(o: { ownerId: number; botId: string | null; mode: 'chat' | 'ask'; title?: string }): ChatSession {
  const s = load()
  const t = Date.now()
  const sess: ChatSession = {
    id: randomUUID(),
    title: o.title || 'New chat',
    botId: o.botId,
    mode: o.mode,
    messages: [],
    createdAt: t,
    updatedAt: t,
    ownerId: o.ownerId
  }
  s[sess.id] = sess
  save(s)
  return sess
}
```

Change `listSessions` to be uid-scoped, auto-creating the caller's main:

```ts
export function listSessions(uid: number, botId?: string | null): ChatSession[] {
  const store = load()
  const mainId = mainIdFor(uid)
  if (!store[mainId]) {
    store[mainId] = mkMainFor(uid)
    save(store)
  }
  const mine = Object.values(store).filter((x) => x.ownerId === uid)
  const f = botId === undefined ? mine : mine.filter((x) => x.botId === botId || x.id === mainId)
  return f.sort((a, b) => b.updatedAt - a.updatedAt)
}
```

Keep the legacy `MAIN_ID` constant for back-compat but stop relying on it for new reads.

- [ ] **Step 4: Update `chat.ts` to pass uid + enforce scope**

In `chat.ts`: where sessions are listed/created/read, pass `c.auth.userId`; replace `S.getSession(...)` with `S.getSessionFor(c.auth.userId, id)`; default to `S.mainIdFor(c.auth.userId)` instead of `S.MAIN_ID`. Before running an `ask`/per-bot agent, verify visibility:

```ts
import { botsVisibleTo } from '../authz'
// ...
if (sess.botId) {
  const visible = new Set(botsVisibleTo(c.auth.userId, c.auth.isOwner).map((e) => e.id))
  if (!visible.has(sess.botId)) { c.json(403, { error: 'forbidden' }); return }
}
```

For fleet (`chat` mode) the agent runs with `scope: 'fleet'`; constrain the model's view by passing only visible bot ids if the runAgent fleet path enumerates bots (follow the existing `runAgent` signature; if it reads the registry directly, gate there in a later Phase — for Phase 1 the per-bot `ask` guard above is the security-critical path and MUST land).

- [ ] **Step 5: Run the test + chat tests; expect pass**

Run: `npx vitest run src/main/core/__tests__/miniapp.sessions.tenancy.test.ts && npx vitest run -t chat`
Expected: new tests PASS; existing chat tests still PASS (update any that called `createSession`/`listSessions` with the old signature).

- [ ] **Step 6: Commit (local)**

```bash
git add src/main/core/miniapp/sessions.ts src/main/core/miniapp/routes/chat.ts src/main/core/__tests__/miniapp.sessions.tenancy.test.ts
git commit -m "feat(tenancy): per-tenant chat sessions + visibility-gated ask"
```

---

### Task 7: Control-bot bot-list filtering

**Files:**
- Modify: `src/main/core/telegramBot.ts`
- Test: `src/main/core/__tests__/telegramBot.tenancy.test.ts` (create)

**Interfaces:**
- Consumes: `getHostUid` (Task 1); `botsVisibleTo`, `can` (Task 3); existing `sup.listBots()`, `findEntry`.
- Produces: a helper `visibleBotsFor(senderUid)` used wherever the bot replies with a bot list (`/status`, `/list`, `/logs`, callbacks). Host sees all; a tenant sees only owned/collaborated; callbacks (`start/stop/restart/update/remove/env/logs/ask/fix`) deny on a non-visible/uncapable bot.

- [ ] **Step 1: Read the dispatch + callback sections**

Run: `sed -n '380,460p;520,600p;800,860p' src/main/core/telegramBot.ts`
Locate each `await sup.listBots()` used to build a reply, and the callback `switch (action)` block.

- [ ] **Step 2: Write the failing test**

Create `src/main/core/__tests__/telegramBot.tenancy.test.ts` exercising the smallest pure seam you can extract. Add and export a pure helper in `telegramBot.ts`:

```ts
export function filterVisible<T extends { manifest: { id: string } }>(
  bots: T[], senderUid: number, isHost: boolean
): T[] {
  const visible = new Set(botsVisibleTo(senderUid, isHost).map((e) => e.id))
  return bots.filter((b) => visible.has(b.manifest.id))
}
```

Test:

```ts
import { describe, it, expect, vi } from 'vitest'
vi.mock('../registry', () => ({
  readRegistry: () => [
    { id: 'a', name: 'A', dirName: 'a', ownerId: 7 },
    { id: 'b', name: 'B', dirName: 'b', ownerId: 1 }
  ],
  findEntry: (id: string) => ({ a: { id: 'a', ownerId: 7 }, b: { id: 'b', ownerId: 1 } } as never)[id]
}))
import { filterVisible } from '../telegramBot'

const bots = [{ manifest: { id: 'a' } }, { manifest: { id: 'b' } }]
describe('control-bot visibility', () => {
  it('tenant sees only their bot', () => {
    expect(filterVisible(bots, 7, false).map((b) => b.manifest.id)).toEqual(['a'])
  })
  it('host sees all', () => {
    expect(filterVisible(bots, 1, true).map((b) => b.manifest.id).sort()).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 3: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/telegramBot.tenancy.test.ts`
Expected: FAIL (`filterVisible` not exported).

- [ ] **Step 4: Implement**

Add `import { botsVisibleTo, can } from './miniapp/authz'` and the `filterVisible` helper above. At each reply that lists bots, wrap with `filterVisible(await sup.listBots(), chatId, isOwner)`. In the callback `switch`, before performing `start/stop/restart/update/remove`, resolve the entry and guard:

```ts
const entry = findEntry(id)
const cap = action === 'remove' ? null : 'startStop'
if (action === 'remove') {
  if (!isOwner && entry?.ownerId !== chatId) { await this.answer(cb.id, 'Not allowed'); return }
} else if (!can(chatId, isOwner, entry, 'startStop')) {
  await this.answer(cb.id, 'Not allowed'); return
}
```

(`isOwner` here is the host flag already computed at `telegramBot.ts:401` as `isAuthorized(chatId, cfg.ownerChatId)`.)

- [ ] **Step 5: Run the test; expect pass**

Run: `npx vitest run src/main/core/__tests__/telegramBot.tenancy.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit (local)**

```bash
git add src/main/core/telegramBot.ts src/main/core/__tests__/telegramBot.tenancy.test.ts
git commit -m "feat(tenancy): control bot filters bot lists + guards actions by ownership"
```

---

### Task 8: Frontend — tenant vs host rendering + empty workspace

**Files:**
- Modify: `src/main/core/miniapp/frontend/views/settings.ts`
- Modify: `src/main/core/miniapp/frontend/views/fleet.ts`
- Test: manual + existing frontend tests (`npx vitest run -t miniapp`)

**Interfaces:**
- Consumes: the state payload from Task 5 (host settings present only when host; bots already filtered).
- Produces: settings view renders host-only sections only when the payload includes them; fleet view shows the empty-workspace onboarding when the tenant owns no bots (the empty-state CTA already exists from the UI work).

- [ ] **Step 1: Confirm the client already keys off an `isOwner`/settings-present signal**

Run: `grep -n "isOwner\|settings\|ownerOnly\|host" src/main/core/miniapp/frontend/views/settings.ts | head`
If the payload exposes `isOwner` or omits `settings` for tenants (Task 5), branch on that. Do NOT add backtick/`${}` template literals inside embedded JS strings (Global Constraints).

- [ ] **Step 2: Implement conditional rendering**

In `settings.ts`, guard host-only section assembly behind the presence of host settings in the payload (e.g. `if (state.settings)` — tenants won't receive it). In `fleet.ts`, when the filtered bot list is empty, render the existing empty-state onboarding ("deploy your first bot") rather than an empty fleet. Use string concatenation, not template literals, consistent with the surrounding view code.

- [ ] **Step 3: Verify build + view tests**

Run: `npm run build && npx vitest run -t miniapp`
Expected: build succeeds; miniapp view tests PASS.

- [ ] **Step 4: Commit (local)**

```bash
git add src/main/core/miniapp/frontend/views/settings.ts src/main/core/miniapp/frontend/views/fleet.ts
git commit -m "feat(tenancy): tenant-scoped settings + empty-workspace fleet view"
```

---

### Final verification (run after all tasks)

- [ ] `npm run typecheck` → clean
- [ ] `npm test` → all green (no regressions; the 2 pre-existing skips remain skipped)
- [ ] `npm run build` → succeeds
- [ ] Manual smoke: as host, see all bots; approve a second test account → it opens to an empty workspace and cannot see host bots; that account imports a bot → sees only its own; host still sees everything.

---

## Notes for the executor

- The host (you) is identified by `control.ownerChatId` (= `notify.chatId`). If that is unset, `getHostUid()` is `null` and migration won't stamp ownership — ensure the notifier chatId is configured before relying on migration.
- This is Phase 1 (isolation). Collaboration invites + the capability-toggle UI + secret-reveal gating are **Phase 2** and intentionally absent here; the `collaborators` field and `can()` already support them so Phase 2 is additive.
- AI metering is **Phase 3**; `getLimits().aiPerDay` exists but is not enforced yet.
