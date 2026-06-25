# Collaborators ("Team") Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated **Team** navbar tab that lets a user manage collaborators across all their bots in one place and see bots shared with them.

**Architecture:** A new read endpoint `GET /api/collaborations` returns the caller's owned bots (with collaborators + addable picker) and bots shared with them (with their caps). A new frontend view `collaboratorsView` renders both sections as a navbar tab; mutations reuse the existing Phase-2 `POST /api/bots/collaborators` + `/remove` routes.

**Tech Stack:** TypeScript (Node ESM), Vitest, Electron main process; embedded-JS frontend views assembled into `MINIAPP_HTML`.

## Global Constraints

- Do NOT modify: `src/main/core/__tests__/integration.launchd.test.ts`, `src/main/core/launchctl.ts`, `src/main/core/monitor.ts`.
- Embedded frontend view strings (`miniapp/frontend/**`): NO backtick template literals or `${}` — single-quoted concatenation only, matching the existing views.
- `RouteCtx.auth = { userId: number; isOwner: boolean }` (`isOwner` = host). The new endpoint is read-only and `ownerOnly: false`; it returns only what ownership/`can()` already authorize (profiles + capability booleans, never secret values).
- The six capabilities are exactly: `viewLogs, chat, startStop, deploy, editEnv, viewSecrets`.
- All collaborator *mutations* reuse the existing `POST /api/bots/collaborators` (add/update) and `POST /api/bots/collaborators/remove` routes — do NOT add new write endpoints or new authorization.
- Run the FULL suite with `npm test`; typecheck `npm run typecheck`; build (compiles embedded frontend) `npm run build`. Local commits only; no push; no secrets.

---

### Task 1: `GET /api/collaborations` endpoint

**Files:**
- Modify: `src/main/core/miniapp/routes/collaborators.ts`
- Modify: `src/main/core/miniapp/routes/index.ts` (already spreads `collaboratorRoutes`; just confirm the new route is in that array)
- Test: `src/main/core/__tests__/miniapp.collaborations.test.ts` (create)

**Interfaces:**
- Consumes: `readRegistry` (registry), `type Capabilities` (registry), `getApprovedProfiles`, `getUserProfile`, `getHostUid` (config); `RouteCtx`, `Route`.
- Produces: a `GET /api/collaborations` route returning `{ owned: Array<{id,name,collaborators:Array<UserProfile&{caps}>,addable:UserProfile[]}>, shared: Array<{id,name,owner:UserProfile,caps:Capabilities}> }`.

- [ ] **Step 1: Write the failing test**

Create `src/main/core/__tests__/miniapp.collaborations.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('../registry', () => ({
  // a: owned by 7, collaborator 2 ; b: owned by 1 (host) collaborator 7 ; c: owned by 9 (someone else), no rel to 7
  readRegistry: () => [
    { id: 'a', name: 'A', dirName: 'a', ownerId: 7, collaborators: { '2': { viewLogs: true } } },
    { id: 'b', name: 'B', dirName: 'b', ownerId: 1, collaborators: { '7': { chat: true } } },
    { id: 'c', name: 'C', dirName: 'c', ownerId: 9, collaborators: {} }
  ],
  findEntry: () => undefined,
  setCollaborator: vi.fn(),
  removeCollaborator: vi.fn()
}))
vi.mock('../config', () => ({
  getApprovedProfiles: () => [ { id: 1, username: 'host' }, { id: 7, username: 'me' }, { id: 2, username: 'bob' }, { id: 3, username: 'sam' } ],
  getApprovedUsers: () => [1, 7, 2, 3],
  getUserProfile: (id: number) => ({ id, username: 'u' + id }),
  getHostUid: () => 1
}))

import { collaboratorRoutes } from '../miniapp/routes/collaborators'

function call(auth: { userId: number; isOwner: boolean }) {
  const json = vi.fn()
  const route = collaboratorRoutes.find((r) => r.path === '/api/collaborations' && r.method === 'GET')!
  return Promise.resolve(route.handler({ auth, json, url: new URL('http://x/api/collaborations'), body: {} } as never))
    .then(() => json.mock.calls[0][1] as { owned: Array<{ id: string; collaborators: unknown[]; addable: { id: number }[] }>; shared: Array<{ id: string; caps: unknown; owner: { id: number } }> })
}

describe('GET /api/collaborations', () => {
  it('tenant: owns a (with collaborator 2), is shared b', async () => {
    const p = await call({ userId: 7, isOwner: false })
    expect(p.owned.map((o) => o.id)).toEqual(['a'])
    expect(p.owned[0].collaborators.length).toBe(1)
    expect(p.owned[0].addable.map((u) => u.id).sort()).toEqual([3]) // excludes host(1), owner(7), existing(2)
    expect(p.shared.map((s) => s.id)).toEqual(['b'])
    expect(p.shared[0].owner.id).toBe(1)
  })
  it('host sees all bots under owned, none shared', async () => {
    const p = await call({ userId: 1, isOwner: true })
    expect(p.owned.map((o) => o.id).sort()).toEqual(['a', 'b', 'c'])
    expect(p.shared).toEqual([])
  })
  it('user with neither gets empty arrays', async () => {
    const p = await call({ userId: 42, isOwner: false })
    expect(p.owned).toEqual([])
    expect(p.shared).toEqual([])
  })
})
```

- [ ] **Step 2: Run it; expect failure**

Run: `npx vitest run src/main/core/__tests__/miniapp.collaborations.test.ts`
Expected: FAIL (route `/api/collaborations` not found).

- [ ] **Step 3: Implement in `collaborators.ts`**

Add `readRegistry` to the registry import (keep the existing `findEntry, setCollaborator, removeCollaborator, type Capabilities`):

```ts
import { findEntry, setCollaborator, removeCollaborator, readRegistry, type Capabilities } from '../../registry'
```

Add the handler (near the others) and register the route:

```ts
function collaborations(c: RouteCtx): void {
  const uid = c.auth.userId
  const isHost = c.auth.isOwner
  const host = getHostUid()
  const entries = readRegistry()
  const owned = entries
    .filter((e) => isHost || e.ownerId === uid)
    .map((e) => {
      const map = e.collaborators ?? {}
      const collaborators = Object.keys(map).map((u) => ({ ...getUserProfile(Number(u)), caps: map[u] }))
      const existing = new Set(Object.keys(map).map(Number))
      const addable = getApprovedProfiles().filter((p) => p.id !== host && p.id !== e.ownerId && !existing.has(p.id))
      return { id: e.id, name: e.name, collaborators, addable }
    })
  const shared = entries
    .filter((e) => e.ownerId !== uid && e.collaborators && e.collaborators[String(uid)])
    .map((e) => ({ id: e.id, name: e.name, owner: getUserProfile(e.ownerId as number), caps: (e.collaborators as Record<string, Capabilities>)[String(uid)] }))
  c.json(200, { owned, shared })
}
```

Add to `collaboratorRoutes`:

```ts
  { method: 'GET', path: '/api/collaborations', ownerOnly: false, handler: collaborations },
```

(`getApprovedProfiles`, `getUserProfile`, `getHostUid` are already imported from `'../../config'` in this file.)

- [ ] **Step 4: Run the test; expect pass**

Run: `npx vitest run src/main/core/__tests__/miniapp.collaborations.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `npm run typecheck && npm test`
```bash
git add src/main/core/miniapp/routes/collaborators.ts src/main/core/__tests__/miniapp.collaborations.test.ts
git commit -m "feat(team): GET /api/collaborations (owned + shared) for the Team tab"
```

---

### Task 2: "Team" tab frontend view

**Files:**
- Create: `src/main/core/miniapp/frontend/views/collaborators.ts`
- Modify: `src/main/core/miniapp/frontend/index.ts` (import + add to the `assemble([...])` array)
- Verify: `npm run build` + `npm test`

**Interfaces:**
- Consumes: `GET /api/collaborations` (Task 1) and the existing `POST /api/bots/collaborators` + `/api/bots/collaborators/remove` routes.
- Produces: `export const collaboratorsView: { js: string }` that self-registers a `'team'` view; wired into `MINIAPP_HTML`.

- [ ] **Step 1: Read the reference view + assembly**

Run: `sed -n '1,40p' src/main/core/miniapp/frontend/views/settings.ts` and `sed -n '180,190p' src/main/core/miniapp/frontend/views/fleet.ts` (the `loadCollaborators` function and how it renders collaborator rows + toggles + add picker) and `cat src/main/core/miniapp/frontend/index.ts`.
Note the embedded-JS style: `export const xView: { js: string } = { js: '' + 'function …' + '…' + 'App.registerView(\'id\',{…});' }`. The six capability keys + labels used by `loadCollaborators` in fleet.ts: viewLogs='Logs', chat='Chat', startStop='Start/Stop', deploy='Deploy', editEnv='Edit Env', viewSecrets='View Secrets'.

- [ ] **Step 2: Create `views/collaborators.ts`**

Create `src/main/core/miniapp/frontend/views/collaborators.ts` exporting `collaboratorsView: { js: string }`. The JS (single-quoted concatenation, NO backticks/`${}`) must:
- Define a `render(root, st)` that sets a loading placeholder then `App.api('/api/collaborations').then(function(data){ … }).catch(...)`.
- Render two sections into `root`:
  - **"Bots you share"** from `data.owned`: for each bot, a `glass card` with the bot name and, for each collaborator, a row (`data-uid`) showing the display name (prefer firstName/lastName, else '@'+username, else id) + six checkboxes (`data-cap="<key>"`, checked from `caps[key]===true`) + a remove button (`data-uid`); plus an "Add collaborator" `<select id="...">` populated from that bot's `addable` (option value=id, label=name/@handle) + an Add button. If a bot has no collaborators show a muted hint; if `addable` is empty show 'No more tenants to add.'.
  - **"Shared with you"** from `data.shared`: read-only rows — bot name, 'shared by '+ (owner name/@handle), and the caps the caller has (render the truthy cap keys as small labels). No controls.
  - If `data.owned.length===0 && data.shared.length===0`, render an empty-state card: 'No shared bots yet. Open a bot and add a collaborator, or ask an owner to share one with you.'.
- Wire events after render (mirror fleet.ts `loadCollaborators`): a cap checkbox change → build the full six-key object from that row's checkboxes → `App.api('/api/bots/collaborators',{method:'POST',body:JSON.stringify({botId:<id>,userId:Number(uid),capabilities:capObj})})` then re-fetch+re-render (call render(root, App.state) or a local reload); remove → `App.api('/api/bots/collaborators/remove',{method:'POST',body:JSON.stringify({botId:<id>,userId:Number(uid)})})` then reload; Add → POST with all six caps false then reload. On error, `App.toast(e.message,'err')`.
- End the JS with: `App.registerView('team',{label:'Team',icon:App.icon('users'),render:render});` (use an existing icon name that resolves in `App.icon`; if 'users' is not defined, use one that is, e.g. the same icon another view uses — confirm against the icon set in shell.ts). No `owner:true` (visible to all).

- [ ] **Step 3: Register in `frontend/index.ts`**

Add the import and include it in the assemble array:

```ts
import { collaboratorsView } from './views/collaborators'
// ...
export const MINIAPP_HTML = assemble([fleetView, chatView, settingsView, botsManageView, collaboratorsView])
```

- [ ] **Step 4: Build + full suite**

Run: `npm run build && npm test`
Expected: build succeeds (a stray backtick/`${}` or JS syntax error fails here); full suite green (no backend test changes). Then sanity-check the tab is in the bundle:
Run: `node -e "const {MINIAPP_HTML}=require('./out/main/index.js')||{}" ` is not reliable; instead `npm run build` success + `grep -c "registerView('team'" out/renderer/* 2>/dev/null || true` — confirm the registration string is present in the built output (or grep the source view file).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/miniapp/frontend/views/collaborators.ts src/main/core/miniapp/frontend/index.ts
git commit -m "feat(team): Team navbar tab (manage shared bots + bots shared with you)"
```

---

### Final verification (after both tasks)

- [ ] `npm run typecheck` → clean
- [ ] `npm test` → all green
- [ ] `npm run build` → succeeds
- [ ] Manual smoke: open the Mini App → a **Team** tab appears in the navbar; as owner it lists your bots with collaborators + add/remove/toggles; a collaborator sees bots shared with them under "Shared with you".

---

## Notes for the executor

- Mutations reuse existing, already-authorized routes — do not add new write endpoints or auth.
- The endpoint returns profiles + capability booleans only; never secret values.
- Confirm the icon name passed to `App.icon(...)` exists in the shell's icon set; if unsure, reuse an icon another registered view already uses.
