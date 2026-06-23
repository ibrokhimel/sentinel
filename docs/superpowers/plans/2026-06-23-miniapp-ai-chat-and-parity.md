# Mini App AI Chat, Sessions, Parity & Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Sentinel Telegram Mini App to feature parity with the control bot — adding an AI chat with Claude-Code-style sessions, bot import/remove/upload, git update/push/apply, AI-connection test, and user-approval management — on a redesigned modular dark-glassmorphic UI.

**Architecture:** Split the two monolith files (`miniapp/service.ts` request handler, `miniapp/frontend.ts` HTML string) into modules so parallel agents own isolated files. Backend: a thin server + a `routes/` table of `{method,path,ownerOnly,handler}`. Frontend: a `frontend/` shell (design system + animation framework + view registry) plus one fragment module per view, assembled into the same exported `MINIAPP_HTML` string. All AI work reuses the existing `agent/` backend (`chatStream`, `runAgent`, `ping`, on-disk memory). Streaming uses `fetch()` POST → chunked `text/event-stream`.

**Tech Stack:** TypeScript, Node `node:http` + `node:crypto` (no new deps), Electron (electron-vite/electron-builder), Vitest, vanilla JS embedded in TS template strings, Telegram WebApp SDK.

## Global Constraints

- **No new runtime dependencies.** Backend stays `node:http` + `node:crypto` + `node:child_process`; frontend stays vanilla JS + the Telegram WebApp script. (Verbatim from spec §6 / current `service.ts` header.)
- **Embedded-string frontend only.** No loose `public/` asset files — electron-builder ships `out/**/*` and electron-vite bundles main into JS; assets would not be copied. Frontend ships as TS strings.
- **Inline JS avoids backtick template literals and `${}`.** It nests inside the TS template string; use `'a' + b` concatenation. (Verbatim from `frontend.ts` header.)
- **Owner-only on every mutation.** Reuse the existing auth: HMAC initData verify + `isOwner || isUserApproved`; POST/mutations require `auth.isOwner`. Non-owner/forged → 401/403.
- **`control.enabled` and `backgroundAgent` stay read-only from the phone.** Toggling either kills the dashboard.
- **Secrets never cross the wire in clear.** Keys matching `/TOKEN|HASH|SECRET|PASSWORD|KEY|API_ID|SESSION/i` are masked; blank-on-save means keep existing.
- **Gate before any live deploy:** `npm run typecheck && npm test && npm run build` must be green, then restart via `launchctl kickstart -k gui/$(id -u)/com.sentinel.monitor`.
- **v1 chat is read-only.** Bot sessions are `mode:'ask'` (no writes); Main is `mode:'chat'` (streaming). `mode:'fix'` is out of scope.

---

## File Structure

**Backend — `src/main/core/miniapp/`**
- `service.ts` *(modify)* — thin server: tunnel/menu-button (unchanged), auth (unchanged), body-read, and a dispatch loop over the route table. Keeps `verifyInitData`, `readBody`, `start/stop/refresh`, tunnel code.
- `routes/index.ts` *(create)* — `RouteCtx`/`Route` types + `ROUTES` array aggregating every feature's routes.
- `routes/state.ts` *(create)* — moves the existing `/api/state`, `/api/logs`, `/api/env` (GET), `/api/action`, `/api/env` (POST), `/api/settings` handlers + `SECRET_KEY_RE`.
- `routes/chat.ts` *(create, Wave 2)* — session CRUD + `/api/chat/stream`.
- `routes/bots.ts` *(create, Wave 2)* — import/remove/upload.
- `routes/git.ts` *(create, Wave 2)* — update/push/apply.
- `routes/agentTest.ts` *(create, Wave 2)* — provider test.
- `routes/users.ts` *(create, Wave 2)* — approval mgmt.
- `sessions.ts` *(create, Wave 2)* — `ChatSession` store, persisted JSON.

**Frontend — `src/main/core/miniapp/frontend/`**
- `index.ts` *(create)* — exports `MINIAPP_HTML`, assembled from fragments.
- `shell.ts` *(create)* — `HEAD`, design-system `CSS`, body `SHELL_HTML`, core `JS` (registry, `api()`, `esc`, `dot`, `pill`, toasts, tab bar, view transitions).
- `views/fleet.ts`, `views/botDetail.ts`, `views/settings.ts` *(create, Wave 1)* — reskinned existing views as registered modules.
- `views/chat.ts`, `views/botsManage.ts`, `views/users.ts` *(create, Wave 2)*.
- `frontend.ts` *(delete after index.ts replaces it; keep a 1-line re-export during transition — see Task 1).*

**Tests — `src/main/core/__tests__/`**
- existing `miniapp.test.ts` *(keep/adjust imports)*.
- `miniapp.sessions.test.ts`, `miniapp.chat.test.ts`, `miniapp.bots.test.ts`, `miniapp.git.test.ts`, `miniapp.agentTest.test.ts`, `miniapp.users.test.ts` *(create, Wave 2)*.

**Reused core (do NOT modify):**
- `supervisor.ts`: `listBots()`, `getBot(id)`, `start/stop/restart(id)`, `setAutostart(id,bool)`, `getEnv(id)`, `saveEnv(id,values)`, `importBot(req,log)`, `removeBot(id)`, `updateBot(id,log)`, `pushLive(id,log,token?)`.
- `config.ts`: `getAppConfig()`, `getControlConfig()`, `getAgentConfig()` → `{baseUrl,model,apiKey,ready}`, `isUserApproved(id)`, `getApprovedUsers()`, `approveUser(id)`, `rejectUser(id)`, `setAutoApprove/​setAutoUpdateEnabled/​setNotifyConfig/​setAgentConfig`.
- `agent/provider.ts`: `chatStream(p,messages,onText,signal)`, `chatCompletion(p,messages,tools?,signal?)`, `ping(p)`. Types `AgentProvider {baseUrl,apiKey,model}`, `ChatMessage`.
- `telegramBot.ts`: `tailBotLogs(id,n)`.

---

# WAVE 1 — Foundation (solo, lands first)

Establishes the conventions every Wave-2 agent depends on. Reskin = move existing render logic into modules under the new design system; behavior identical.

### Task 1: Route table + thin `service.ts` (backend backbone)

**Files:**
- Create: `src/main/core/miniapp/routes/index.ts`
- Create: `src/main/core/miniapp/routes/state.ts`
- Modify: `src/main/core/miniapp/service.ts:187-294` (replace `api()`/`action()`/`saveEnv()`/`saveSettings()` with dispatch)
- Test: `src/main/core/__tests__/miniapp.routes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // routes/index.ts
  export interface RouteCtx {
    req: import('node:http').IncomingMessage
    res: import('node:http').ServerResponse
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
  export const ROUTES: Route[]
  ```
- Consumes: existing `supervisor`, `config`, `tailBotLogs`.

- [ ] **Step 1: Write the failing test** — `src/main/core/__tests__/miniapp.routes.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { ROUTES } from '../miniapp/routes/index'

describe('route table', () => {
  it('exposes the existing endpoints with correct methods + owner gating', () => {
    const find = (m: string, p: string) => ROUTES.find((r) => r.method === m && r.path === p)
    expect(find('GET', '/api/state')?.ownerOnly).toBe(false)
    expect(find('GET', '/api/logs')?.ownerOnly).toBe(false)
    expect(find('GET', '/api/env')?.ownerOnly).toBe(false)
    expect(find('POST', '/api/action')?.ownerOnly).toBe(true)
    expect(find('POST', '/api/env')?.ownerOnly).toBe(true)
    expect(find('POST', '/api/settings')?.ownerOnly).toBe(true)
  })
  it('has no duplicate method+path', () => {
    const seen = new Set<string>()
    for (const r of ROUTES) {
      const k = r.method + ' ' + r.path
      expect(seen.has(k)).toBe(false)
      seen.add(k)
    }
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/main/core/__tests__/miniapp.routes.test.ts`
Expected: FAIL — cannot find `routes/index`.

- [ ] **Step 3: Create `routes/state.ts`** — move the six existing handlers verbatim into ctx form. Full file:

```ts
import * as sup from '../../supervisor'
import { getAppConfig, setAutoApprove, setAutoUpdateEnabled, setNotifyConfig, setAgentConfig } from '../../config'
import { tailBotLogs } from '../../telegramBot'
import type { Route, RouteCtx } from './index'

export const SECRET_KEY_RE = /TOKEN|HASH|SECRET|PASSWORD|KEY|API_ID|SESSION/i

async function getState(c: RouteCtx): Promise<void> {
  const bots = await sup.listBots()
  c.json(200, { bots, config: getAppConfig(), owner: c.auth.isOwner })
}
function getLogs(c: RouteCtx): void {
  const id = c.url.searchParams.get('id') ?? ''
  const n = Math.min(200, Math.max(10, Number(c.url.searchParams.get('n')) || 60))
  c.json(200, { text: tailBotLogs(id, n) })
}
function getEnv(c: RouteCtx): void {
  const id = c.url.searchParams.get('id') ?? ''
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
  { method: 'POST', path: '/api/action', ownerOnly: true, handler: postAction },
  { method: 'POST', path: '/api/env', ownerOnly: true, handler: postEnv },
  { method: 'POST', path: '/api/settings', ownerOnly: true, handler: postSettings }
]
```

- [ ] **Step 4: Create `routes/index.ts`** with the types and aggregator:

```ts
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
```

- [ ] **Step 5: Refactor `service.ts`** — replace the `api()` method body (lines 187-232) and delete `action`/`saveEnv`/`saveSettings` (233-288). New `api()`:

```ts
private async api(path: string, req: IncomingMessage, res: ServerResponse, auth: AuthCtx, url: URL): Promise<void> {
  let body: Record<string, unknown> = {}
  if (req.method === 'POST') {
    const text = await readBody(req)
    body = text ? JSON.parse(text) : {}
  }
  const route = ROUTES.find((r) => r.method === req.method && r.path === path)
  if (!route) return this.json(res, 404, { error: 'unknown endpoint' })
  if (route.ownerOnly && !auth.isOwner) return this.json(res, 403, { error: 'owner only' })
  const ctx: RouteCtx = { req, res, url, auth, body, json: (s, p) => this.json(res, s, p) }
  return await route.handler(ctx)
}
```
Add `import { ROUTES, type RouteCtx } from './routes/index'` and remove now-unused imports (`getAppConfig`, `setAutoApprove`, etc.) from `service.ts` (they live in `state.ts` now); keep `getControlConfig`, `isUserApproved` (auth still needs them).

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/main/core/__tests__/miniapp.routes.test.ts src/main/core/__tests__/miniapp.test.ts && npm run typecheck:node`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/main/core/miniapp/service.ts src/main/core/miniapp/routes src/main/core/__tests__/miniapp.routes.test.ts
git commit -m "refactor(miniapp): extract route table; thin service dispatcher"
```

---

### Task 2: Frontend shell — design system, animation framework, view registry

**Files:**
- Create: `src/main/core/miniapp/frontend/shell.ts`
- Create: `src/main/core/miniapp/frontend/index.ts`
- Modify: `src/main/core/miniapp/frontend.ts` → 1-line re-export (`export { MINIAPP_HTML } from './frontend/index'`) so `service.ts` import keeps working.
- Test: `src/main/core/__tests__/miniapp.frontend.test.ts`

**Interfaces:**
- Produces (client-side globals available to every view module's JS):
  - `App.registerView(id, {label, icon, render, owner?})` — register a tab+view. `render(container, state)` paints into `container`.
  - `App.go(id)` — switch active view (animated).
  - `App.state` — `{ bots, config, owner, initData }`.
  - `App.api(path, opts)` — fetch with `X-Tg-Init-Data`; returns parsed JSON, throws on `!ok`.
  - `App.refresh()` — re-GET `/api/state`, repaint current view.
  - `App.toast(msg, kind)` — transient toast (`kind`: `'ok'|'err'`).
  - helpers `App.esc`, `App.dot`, `App.pill`, `App.haptic(kind)`.
- Produces (server-side): `MINIAPP_HTML: string` from `frontend/index.ts`; `HEAD`, `CSS`, `SHELL_HTML`, `CORE_JS` strings + `assemble(views)` from `shell.ts`.

- [ ] **Step 1: Write the failing test** — `miniapp.frontend.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { MINIAPP_HTML } from '../miniapp/frontend/index'

describe('miniapp html', () => {
  it('is a single self-contained document', () => {
    expect(MINIAPP_HTML.startsWith('<!doctype html>')).toBe(true)
    expect(MINIAPP_HTML).toContain('telegram-web-app.js')
  })
  it('exposes the view registry + api helper + tab bar', () => {
    expect(MINIAPP_HTML).toContain('registerView')
    expect(MINIAPP_HTML).toContain('X-Tg-Init-Data')
    expect(MINIAPP_HTML).toContain('id="tabbar"')
  })
  it('contains the glass design tokens + animation keyframes', () => {
    expect(MINIAPP_HTML).toContain('--glass')
    expect(MINIAPP_HTML).toContain('@keyframes')
  })
})
```

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run src/main/core/__tests__/miniapp.frontend.test.ts` → FAIL (no `frontend/index`).

- [ ] **Step 3: Use the `ui-ux-promax` skill** to author the design system. Invoke it and produce, in `shell.ts`, a `CSS` string implementing **modern dark glassmorphic** with these concrete required tokens/classes (the skill refines values; these names are the contract the test + views depend on):
  - `:root` tokens: `--bg`, `--bg2`, `--glass` (translucent surface), `--glass-brd`, `--accent`, `--accent2` (gradient pair), `--glow`, `--txt`, `--hint`, `--ok`, `--err`, `--radius`, `--blur`.
  - classes: `.glass` (backdrop-filter blur + translucent bg + 1px border + soft shadow), `.tabbar` (fixed bottom, safe-area inset), `.tab`/`.tab.active` (gradient pill + glow), `.bubble.user`/`.bubble.ai`, `.cursor` (blinking), `.typing` (3-dot), `.skel` (shimmer), `.dot.run`/`.dot.bad`/`.dot.warn` (animated status dots), `.toast`.
  - `@keyframes`: `blink`, `typing`, `shimmer`, `pulse`, `viewIn` (slide+fade for view transitions).
  - honor `env(safe-area-inset-bottom)` and `prefers-reduced-motion` (disable animations under it).

- [ ] **Step 4: Write the core JS framework** in `shell.ts` as `CORE_JS` (no backticks/`${}`). Full real code:

```ts
export const CORE_JS = `
(function () {
  'use strict';
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  var initData = (tg && tg.initData) || '';
  var root = document.getElementById('view');
  var tabbar = document.getElementById('tabbar');
  var views = [];           // {id,label,icon,render,owner}
  var current = null;

  function esc(s){ return String(s==null?'':s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c];}); }
  function dot(st){ if(st==='running')return '<span class=\"dot run\"></span>'; if(st==='crashed'||st==='crash-looping')return '<span class=\"dot bad\"></span>'; if(st==='scheduled'||st==='starting')return '<span class=\"dot warn\"></span>'; return '<span class=\"dot\"></span>'; }
  function pill(on){ return '<span class=\"pill '+(on?'on':'off')+'\">'+(on?'on':'off')+'</span>'; }
  function haptic(k){ try{ if(tg&&tg.HapticFeedback) tg.HapticFeedback.impactOccurred(k||'light'); }catch(e){} }

  function api(path, opts){
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers['X-Tg-Init-Data'] = initData;
    if (opts.body) opts.headers['Content-Type'] = 'application/json';
    return fetch(path, opts).then(function(r){
      return r.json().then(function(j){ if(!r.ok) throw new Error(j&&j.error?j.error:('HTTP '+r.status)); return j; });
    });
  }
  function toast(msg, kind){
    var t=document.createElement('div'); t.className='toast '+(kind||'ok'); t.textContent=msg;
    document.body.appendChild(t);
    setTimeout(function(){ t.classList.add('show'); },10);
    setTimeout(function(){ t.classList.remove('show'); setTimeout(function(){ t.remove(); },300); }, 2600);
  }
  function registerView(id, def){ def.id=id; views.push(def); }
  function paintTabs(){
    var h='';
    views.forEach(function(v){ if(v.owner && !App.state.owner) return;
      h += '<button class=\"tab'+(current===v.id?' active':'')+'\" data-v=\"'+v.id+'\">'+(v.icon||'')+'<span>'+esc(v.label)+'</span></button>'; });
    tabbar.innerHTML=h;
    Array.prototype.forEach.call(tabbar.querySelectorAll('[data-v]'), function(el){
      el.addEventListener('click', function(){ haptic('light'); go(el.getAttribute('data-v')); });
    });
  }
  function go(id){
    current=id; paintTabs();
    var v=views.filter(function(x){return x.id===id;})[0]; if(!v) return;
    root.classList.remove('viewIn'); void root.offsetWidth; root.classList.add('viewIn');
    root.innerHTML=''; v.render(root, App.state);
  }
  function refresh(){
    return api('/api/state').then(function(s){
      App.state.bots=s.bots||[]; App.state.config=s.config; App.state.owner=!!s.owner;
      paintTabs(); if(current) go(current);
    });
  }
  var App = { state:{ bots:[], config:null, owner:false, initData:initData },
    registerView:registerView, go:go, api:api, refresh:refresh, toast:toast,
    esc:esc, dot:dot, pill:pill, haptic:haptic };
  window.App = App;

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState!=='loading') boot();
  function boot(){
    if (!initData){ root.innerHTML='<div class=\"glass card\"><b>Open this from your Sentinel bot.</b><div class=\"sub\">No signed Telegram session here.</div></div>'; return; }
    refresh().then(function(){ if(!current && views.length) go(views[0].id); })
      .catch(function(e){ root.innerHTML=''; toast(e.message,'err'); });
  }
})();
`
```

- [ ] **Step 5: Write `HEAD` + `SHELL_HTML` + `assemble()`** in `shell.ts`:

```ts
export const HEAD = `<!doctype html><html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Sentinel</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>` + CSS + `</style></head>`

export const SHELL_HTML = `<body>
<div class="topbar"><h1>🛰️ Sentinel</h1><button class="ico" id="refresh">↻</button></div>
<div id="view"></div>
<nav class="tabbar glass" id="tabbar"></nav>`

// views: each contributes { css?, html?, js } — js runs AFTER CORE_JS so App exists.
export function assemble(views: { css?: string; js: string }[]): string {
  const viewCss = views.map((v) => v.css || '').join('\n')
  const viewJs = views.map((v) => v.js).join('\n')
  return HEAD.replace('</style>', viewCss + '</style>')
    + SHELL_HTML
    + '<script>' + CORE_JS + '</script>'
    + '<script>' + viewJs + '</script>'
    + '<script>(function(){var r=document.getElementById("refresh");if(r)r.addEventListener("click",function(){App.haptic("light");App.refresh();});})();</script>'
    + '</body></html>'
}
```
Wire the `refresh` button (done above). Define `CSS` const above `HEAD`.

- [ ] **Step 6: Create `frontend/index.ts`** with an empty view list for now (Task 3 wires the views in — keeping Task 2 self-contained and compilable):

```ts
import { assemble } from './shell'
// Task 3 adds: import { fleetView } from './views/fleet' etc., and passes them here.
export const MINIAPP_HTML = assemble([])
```
Each `views/*.ts` will export `{ css?, js }`. `botDetail` is folded into `fleet` for v1.

- [ ] **Step 7: Replace `frontend.ts` body** with `export { MINIAPP_HTML } from './frontend/index'` so `service.ts`'s `import { MINIAPP_HTML } from './frontend'` still resolves.

- [ ] **Step 8: Run tests** — `npx vitest run src/main/core/__tests__/miniapp.frontend.test.ts && npm run typecheck:node` → PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/core/miniapp/frontend src/main/core/miniapp/frontend.ts src/main/core/__tests__/miniapp.frontend.test.ts
git commit -m "feat(miniapp): glassmorphic shell — design system, animations, view registry"
```

---

### Task 3: Reskin Fleet + Bot detail + Settings into view modules

**Files:**
- Create: `src/main/core/miniapp/frontend/views/fleet.ts` (includes bot-detail render)
- Create: `src/main/core/miniapp/frontend/views/settings.ts`
- Modify: `src/main/core/miniapp/frontend/index.ts` (import both views; pass to `assemble([...])`)
- Test: extend `miniapp.frontend.test.ts`

**Interfaces:**
- Consumes: `App.*` from Task 2.
- Produces: `export const fleetView: { css?: string; js: string }`, `export const settingsView: { css?: string; js: string }`.

- [ ] **Step 1: Add failing assertions** to `miniapp.frontend.test.ts`:

```ts
it('registers fleet + settings views', () => {
  expect(MINIAPP_HTML).toContain("registerView('fleet'")
  expect(MINIAPP_HTML).toContain("registerView('settings'")
})
it('fleet view renders bot rows + opens detail; settings has AI section', () => {
  expect(MINIAPP_HTML).toContain('openDetail')
  expect(MINIAPP_HTML).toContain('data-act="start"')
  expect(MINIAPP_HTML).toContain('AI agent')
})
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/main/core/__tests__/miniapp.frontend.test.ts` → FAIL.

- [ ] **Step 3: Write `views/fleet.ts`** — port `renderFleet`/`openDetail`/`renderDetail`/`doAction`/`loadLogs`/`loadEnv` from the current `frontend.ts:152-264` into a self-registering module, swapping bespoke classes for `.glass`/`.bubble`/animated `App.dot()`, and using `App.api`/`App.toast`/`App.state`. Register:

```ts
export const fleetView = { js: `
(function(){
  function render(root, st){
    if(!st.bots.length){ root.innerHTML='<div class="glass card sub">No bots yet — add one from the Bots tab.</div>'; return; }
    var running=st.bots.filter(function(b){return b.runtime.status==='running';}).length;
    var h='<div class="sub">'+running+'/'+st.bots.length+' running</div>';
    st.bots.forEach(function(b){ var r=b.runtime;
      var meta=r.status==='running'?((r.pid?'pid '+r.pid:'running')+(r.cpu!=null?' · '+r.cpu+'%':'')):(r.status==='crashed'?'exit '+(r.lastExitCode==null?'?':r.lastExitCode):r.status);
      h+='<div class="glass card botrow" data-id="'+App.esc(b.manifest.id)+'">'+App.dot(r.status)+'<span class="name">'+App.esc(b.manifest.name)+'</span><span class="sub">'+App.esc(meta)+'</span></div>'; });
    root.innerHTML=h;
    Array.prototype.forEach.call(root.querySelectorAll('.botrow'),function(el){ el.addEventListener('click',function(){ App.haptic('light'); openDetail(el.getAttribute('data-id'),root); }); });
  }
  function openDetail(id, root){ /* port renderDetail/doAction/loadLogs/loadEnv here, using App.api/App.toast */ }
  App.registerView('fleet', { label:'Fleet', icon:'🛰️', render:render });
})();
` }
```
Port the detail/logs/env bodies verbatim from current `frontend.ts` (lines 178-264), substituting `api`→`App.api`, `showErr`→`App.toast(.,'err')`, `esc`→`App.esc`, `dot`→`App.dot`, `pill`→`App.pill`, `state`→the `st` passed in / `App.state`, and `render()`→re-`openDetail`/`App.go('fleet')`. **Show the full ported code** (do not leave the `/* port ... */` comment — expand it).

- [ ] **Step 4: Write `views/settings.ts`** — port `renderSettings`/`switchRow`/`field`/`wireSwitches`/`saveSettings` from `frontend.ts:267-336` into a registered `settingsView` with `owner` not required to view (read-only fields when `!st.owner`). Use `.glass` cards. Expand the full ported code.

- [ ] **Step 4b: Wire the views into `frontend/index.ts`** — change it to import and assemble them:

```ts
import { assemble } from './shell'
import { fleetView } from './views/fleet'
import { settingsView } from './views/settings'
export const MINIAPP_HTML = assemble([fleetView, settingsView])
```

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run src/main/core/__tests__/miniapp.frontend.test.ts && npm run typecheck && npm run build`
Expected: PASS, build clean (proves the embedded HTML packages).

- [ ] **Step 6: Commit**

```bash
git add src/main/core/miniapp/frontend/views
git commit -m "feat(miniapp): reskin fleet, bot detail, settings into view modules"
```

**Wave-1 gate:** `npm run typecheck && npm test && npm run build` all green before fanning out Wave 2.

---

# WAVE 2 — Features (parallel; each agent owns its files)

Each task adds one `routes/<feature>.ts` (append its array to `ROUTES` in `routes/index.ts`) and one `views/<feature>.ts` (add to the `assemble([...])` list in `frontend/index.ts`). `routes/index.ts` and `frontend/index.ts` are the only shared merge points — the lead integrates them.

### Task 4: AI chat + sessions

**Files:**
- Create: `src/main/core/miniapp/sessions.ts`
- Create: `src/main/core/miniapp/routes/chat.ts`
- Create: `src/main/core/miniapp/frontend/views/chat.ts`
- Modify: `routes/index.ts` (+`...chatRoutes`), `frontend/index.ts` (+`chatView`)
- Test: `src/main/core/__tests__/miniapp.sessions.test.ts`, `miniapp.chat.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // sessions.ts
  export interface ChatSession { id: string; title: string; botId: string | null; mode: 'chat'|'ask'; messages: {role:'user'|'assistant';content:string;ts:number}[]; createdAt: number; updatedAt: number }
  export function listSessions(botId?: string | null): ChatSession[]
  export function getSession(id: string): ChatSession | null
  export function createSession(o: { botId: string | null; mode: 'chat'|'ask'; title?: string }): ChatSession
  export function renameSession(id: string, title: string): ChatSession | null
  export function deleteSession(id: string): boolean   // false for 'main'
  export function resetSession(id: string): ChatSession | null
  export function appendTurn(id: string, user: string, assistant: string): void
  export const MAIN_ID = 'main'
  export const chatRoutes: import('./routes/index').Route[]  // re-exported via routes/chat.ts
  ```
- Consumes: `getAgentConfig()`, `chatStream`, `runAgent`, `getBot`, `RouteCtx`.

- [ ] **Step 1: Resolve the data dir** — run:
`grep -rn "conversations.json\|dataHome\|DATA_HOME\|\.sentinel" src/main/core/agent/memory.ts src/main/core/config.ts src/main/core/paths.ts 2>/dev/null`
Use the SAME exported path helper `memory.ts` uses (e.g. `dataDir()`/`dataHome()`). If none is exported, import the directory constant it uses. Record the symbol; use it in Step 3 as `SESS_FILE = join(<dataDir>, 'miniapp-sessions.json')`.

- [ ] **Step 2: Write the failing store test** — `miniapp.sessions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

beforeEach(() => { process.env.SENTINEL_DATA_HOME = mkdtempSync(join(tmpdir(), 'sent-')) })

describe('sessions store', () => {
  it('always has a non-deletable Main session', async () => {
    const s = await import('../miniapp/sessions')
    const main = s.getSession(s.MAIN_ID)
    expect(main?.botId).toBe(null)
    expect(main?.mode).toBe('chat')
    expect(s.deleteSession(s.MAIN_ID)).toBe(false)
  })
  it('creates, lists by bot, renames, resets, appends with caps', async () => {
    const s = await import('../miniapp/sessions')
    const a = s.createSession({ botId: 'bot1', mode: 'ask', title: 'Investigate' })
    expect(s.listSessions('bot1').map((x) => x.id)).toContain(a.id)
    expect(s.renameSession(a.id, 'Renamed')?.title).toBe('Renamed')
    for (let i = 0; i < 40; i++) s.appendTurn(a.id, 'u' + i, 'a' + i)
    expect(s.getSession(a.id)!.messages.length).toBeLessThanOrEqual(32)
    expect(s.resetSession(a.id)?.messages.length).toBe(0)
    expect(s.deleteSession(a.id)).toBe(true)
  })
})
```
(If `memory.ts` uses a different env var than `SENTINEL_DATA_HOME`, set that one in `beforeEach` — adjust per Step 1.)

- [ ] **Step 3: Run, verify fail** — `npx vitest run src/main/core/__tests__/miniapp.sessions.test.ts` → FAIL.

- [ ] **Step 4: Implement `sessions.ts`** — JSON file persistence, `randomUUID`, caps (max 16 turns/32 messages, drop oldest; truncate combined content > 14000 chars). Ensure `MAIN` is created on first load. Full implementation (using the path helper from Step 1 as `dataDir()`):

```ts
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { dataDir } from '../paths' // ← replace with the symbol found in Step 1

export interface ChatSession { id: string; title: string; botId: string | null; mode: 'chat'|'ask'; messages: { role:'user'|'assistant'; content:string; ts:number }[]; createdAt: number; updatedAt: number }
export const MAIN_ID = 'main'
const MAX_MSGS = 32
const MAX_CHARS = 14000
const FILE = () => join(dataDir(), 'miniapp-sessions.json')

type Store = Record<string, ChatSession>
function load(): Store {
  try { const s = JSON.parse(readFileSync(FILE(), 'utf8')) as Store; if (!s[MAIN_ID]) s[MAIN_ID] = mkMain(); return s }
  catch { return { [MAIN_ID]: mkMain() } }
}
function mkMain(): ChatSession { const t = Date.now(); return { id: MAIN_ID, title: 'Main', botId: null, mode: 'chat', messages: [], createdAt: t, updatedAt: t } }
function save(s: Store): void { const f = FILE(); if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(s)) }

export function listSessions(botId?: string | null): ChatSession[] {
  const all = Object.values(load())
  const f = botId === undefined ? all : all.filter((x) => x.botId === botId || x.id === MAIN_ID)
  return f.sort((a, b) => b.updatedAt - a.updatedAt)
}
export function getSession(id: string): ChatSession | null { return load()[id] ?? null }
export function createSession(o: { botId: string | null; mode: 'chat'|'ask'; title?: string }): ChatSession {
  const s = load(); const t = Date.now()
  const sess: ChatSession = { id: randomUUID(), title: o.title || 'New chat', botId: o.botId, mode: o.mode, messages: [], createdAt: t, updatedAt: t }
  s[sess.id] = sess; save(s); return sess
}
export function renameSession(id: string, title: string): ChatSession | null {
  const s = load(); if (!s[id]) return null; s[id].title = title.slice(0, 80); s[id].updatedAt = Date.now(); save(s); return s[id]
}
export function deleteSession(id: string): boolean { if (id === MAIN_ID) return false; const s = load(); if (!s[id]) return false; delete s[id]; save(s); return true }
export function resetSession(id: string): ChatSession | null { const s = load(); if (!s[id]) return null; s[id].messages = []; s[id].updatedAt = Date.now(); save(s); return s[id] }
export function appendTurn(id: string, user: string, assistant: string): void {
  const s = load(); const sess = s[id]; if (!sess) return; const ts = Date.now()
  sess.messages.push({ role: 'user', content: user, ts }, { role: 'assistant', content: assistant, ts })
  while (sess.messages.length > MAX_MSGS) sess.messages.shift()
  let total = sess.messages.reduce((n, m) => n + m.content.length, 0)
  while (total > MAX_CHARS && sess.messages.length > 2) { total -= sess.messages.shift()!.content.length }
  sess.updatedAt = ts; save(s)
}
```

- [ ] **Step 5: Run store tests** — `npx vitest run src/main/core/__tests__/miniapp.sessions.test.ts` → PASS.

- [ ] **Step 6: Write the failing chat-route test** — `miniapp.chat.test.ts` (unit-test the SSE writer + handlers against a mock `RouteCtx`/`res`):

```ts
import { describe, it, expect, vi } from 'vitest'
import { chatRoutes } from '../miniapp/routes/chat'

function route(method: string, path: string) { return chatRoutes.find((r) => r.method === method && r.path === path)! }

describe('chat routes', () => {
  it('registers session CRUD + stream, all owner-only', () => {
    for (const p of ['/api/chat/sessions','/api/chat/sessions/rename','/api/chat/sessions/delete','/api/chat/sessions/reset','/api/chat/stream'])
      expect(chatRoutes.some((r) => r.path === p)).toBe(true)
    expect(route('POST','/api/chat/stream').ownerOnly).toBe(true)
  })
  it('GET sessions returns Main', async () => {
    const json = vi.fn()
    await route('GET','/api/chat/sessions').handler({ url:new URL('http://x/api/chat/sessions'), auth:{userId:1,isOwner:true}, body:{}, json } as any)
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ sessions: expect.any(Array) }))
  })
})
```

- [ ] **Step 7: Run, verify fail** — FAIL (no `routes/chat`).

- [ ] **Step 8: Implement `routes/chat.ts`**. Session CRUD via `sessions.ts`; `/api/chat/stream` writes chunked `text/event-stream`. For `mode:'chat'` use `chatStream`; for `mode:'ask'` use `runAgent({allowWrites:false,scope:'bot',events})` streaming step events. Provider via `getAgentConfig()` → `{baseUrl, apiKey, model}`; if `!ready`, emit error event. Full handler core:

```ts
import * as sup from '../../supervisor'
import { getAgentConfig } from '../../config'
import { chatStream } from '../../agent/provider'
import { runAgent } from '../../agent/runtime'
import * as S from '../sessions'
import type { Route, RouteCtx } from './index'

function provider() { const a = getAgentConfig(); return { baseUrl: a.baseUrl, apiKey: a.apiKey, model: a.model, ready: a.ready } }

async function stream(c: RouteCtx): Promise<void> {
  const b = c.body as { id?: string; message?: string }
  const sess = b.id ? S.getSession(b.id) : S.getSession(S.MAIN_ID)
  const msg = String(b.message ?? '').trim()
  const res = c.res
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const send = (o: unknown) => res.write('data: ' + JSON.stringify(o) + '\n\n')
  if (!sess) { send({ type: 'error', message: 'no such session' }); return res.end() }
  const p = provider()
  if (!p.ready) { send({ type: 'error', message: 'AI not configured — set it in Settings.' }); return res.end() }
  if (!msg) { send({ type: 'error', message: 'empty message' }); return res.end() }
  const ac = new AbortController()
  c.req.on('close', () => ac.abort())
  let finalText = ''
  try {
    const history = sess.messages.map((m) => ({ role: m.role, content: m.content }))
    if (sess.mode === 'chat') {
      finalText = await chatStream(p, [...history, { role: 'user', content: msg }], (full) => send({ type: 'delta', text: full }), ac.signal)
    } else {
      const bot = await sup.getBot(sess.botId as string)
      finalText = await runAgent({
        provider: p, botId: bot.manifest.id, dir: bot.dir, task: msg, allowWrites: false, scope: 'bot', history,
        events: {
          onText: (t) => send({ type: 'delta', text: t }),
          onTool: (name, args) => send({ type: 'tool', name, args }),
          onToolResult: (name, result) => send({ type: 'tool_result', name, result: String(result).slice(0, 4000) })
        }
      } as Parameters<typeof runAgent>[0])
    }
    S.appendTurn(sess.id, msg, finalText)
    send({ type: 'done', content: finalText })
  } catch (e) { send({ type: 'error', message: String((e as Error)?.message ?? e) }) }
  res.end()
}

export const chatRoutes: Route[] = [
  { method: 'GET', path: '/api/chat/sessions', ownerOnly: true, handler: (c) => { const botId = c.url.searchParams.get('botId'); c.json(200, { sessions: S.listSessions(botId === null ? undefined : botId) }) } },
  { method: 'POST', path: '/api/chat/sessions', ownerOnly: true, handler: (c) => { const b = c.body as any; c.json(200, { session: S.createSession({ botId: b.botId ?? null, mode: b.mode === 'ask' ? 'ask' : 'chat', title: b.title }) }) } },
  { method: 'POST', path: '/api/chat/sessions/rename', ownerOnly: true, handler: (c) => { const b = c.body as any; const s = S.renameSession(String(b.id), String(b.title || '')); c.json(s ? 200 : 404, s ? { session: s } : { error: 'not found' }) } },
  { method: 'POST', path: '/api/chat/sessions/delete', ownerOnly: true, handler: (c) => { const ok = S.deleteSession(String((c.body as any).id)); c.json(ok ? 200 : 400, ok ? { ok: true } : { error: 'cannot delete' }) } },
  { method: 'POST', path: '/api/chat/sessions/reset', ownerOnly: true, handler: (c) => { const s = S.resetSession(String((c.body as any).id)); c.json(s ? 200 : 404, s ? { session: s } : { error: 'not found' }) } },
  { method: 'POST', path: '/api/chat/stream', ownerOnly: true, handler: stream }
]
```
Confirm the exact `runAgent` options/`ChatMessage` shape against `agent/runtime.ts` and adapt field names if they differ (e.g. `dir` may be `bot.dir` vs `bot.manifest.dir`) — fix to match the real types so typecheck passes.

- [ ] **Step 9: Register** — in `routes/index.ts` add `import { chatRoutes } from './chat'` and `...chatRoutes` in `ROUTES`.

- [ ] **Step 10: Run route tests + typecheck** — `npx vitest run src/main/core/__tests__/miniapp.chat.test.ts && npm run typecheck:node` → PASS.

- [ ] **Step 11: Write `frontend/views/chat.ts`** — a Chat tab with: a session bar (current title + ⌄ to open a drawer listing sessions with New/Rename/Delete), a scrollable message list of `.bubble.user`/`.bubble.ai`, a composer (textarea + send). Streaming reader (full real JS, no backticks/`${}`):

```ts
export const chatView = { js: `
(function(){
  var cur=null, sessions=[], streaming=false;
  function loadSessions(cb){ App.api('/api/chat/sessions').then(function(r){ sessions=r.sessions||[]; if(!cur) cur=sessions.filter(function(s){return s.id==='main';})[0]||sessions[0]; cb&&cb(); }); }
  function render(root){
    loadSessions(function(){
      root.innerHTML='<div class="glass card sessbar"><b id="sesstitle"></b><button class="ico" id="sessmenu">⌄</button></div>'
        +'<div id="msgs" class="msgs"></div>'
        +'<div class="composer glass"><textarea id="inp" rows="1" placeholder="Message Sentinel AI…"></textarea><button class="send" id="send">➤</button></div>';
      document.getElementById('sesstitle').textContent=cur?cur.title:'Main';
      paintMsgs(); 
      document.getElementById('send').addEventListener('click', sendMsg);
      document.getElementById('sessmenu').addEventListener('click', function(){ openDrawer(root); });
      var inp=document.getElementById('inp'); inp.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMsg(); }});
    });
  }
  function paintMsgs(){
    var box=document.getElementById('msgs'); if(!box) return; var h='';
    (cur&&cur.messages||[]).forEach(function(m){ h+='<div class="bubble '+(m.role==='user'?'user':'ai')+'">'+App.esc(m.content)+'</div>'; });
    box.innerHTML=h; box.scrollTop=box.scrollHeight;
  }
  function sendMsg(){
    if(streaming) return; var inp=document.getElementById('inp'); var msg=inp.value.trim(); if(!msg) return;
    inp.value=''; App.haptic('light'); cur.messages=cur.messages||[]; cur.messages.push({role:'user',content:msg});
    var box=document.getElementById('msgs');
    box.insertAdjacentHTML('beforeend','<div class="bubble user">'+App.esc(msg)+'</div>');
    var ai=document.createElement('div'); ai.className='bubble ai'; ai.innerHTML='<span class="typing"><i></i><i></i><i></i></span>'; box.appendChild(ai); box.scrollTop=box.scrollHeight;
    streaming=true;
    fetch('/api/chat/stream',{method:'POST',headers:{'Content-Type':'application/json','X-Tg-Init-Data':App.state.initData},body:JSON.stringify({id:cur.id,message:msg})})
      .then(function(r){ var rd=r.body.getReader(), dec=new TextDecoder(), buf='';
        function pump(){ return rd.read().then(function(x){ if(x.done){ done(); return; }
          buf+=dec.decode(x.value,{stream:true}); var parts=buf.split('\\n\\n'); buf=parts.pop();
          parts.forEach(function(line){ line=line.replace(/^data: /,''); if(!line) return; var ev; try{ev=JSON.parse(line);}catch(e){return;}
            if(ev.type==='delta'){ ai.innerHTML=App.esc(ev.text)+'<span class="cursor"></span>'; }
            else if(ev.type==='tool'){ ai.innerHTML='<span class="sub">⚙ '+App.esc(ev.name)+'…</span>'; }
            else if(ev.type==='done'){ ai.innerHTML=App.esc(ev.content); cur.messages.push({role:'assistant',content:ev.content}); }
            else if(ev.type==='error'){ ai.innerHTML='<span class="err">'+App.esc(ev.message)+'</span>'; }
            box.scrollTop=box.scrollHeight; });
          return pump(); }); }
        return pump();
      }).catch(function(e){ ai.innerHTML='<span class="err">'+App.esc(e.message)+'</span>'; }).then(done);
    function done(){ streaming=false; }
  }
  function openDrawer(root){
    var h='<div class="drawer glass"><div class="drawer-h"><b>Sessions</b><button class="ico" id="newsess">+ New</button></div>';
    sessions.forEach(function(s){ h+='<div class="sessrow" data-id="'+App.esc(s.id)+'"><span>'+App.esc(s.title)+(s.botId?' · '+App.esc(s.botId):'')+'</span>'
      +'<span><button class="ico" data-ren="'+App.esc(s.id)+'">✎</button>'+(s.id==='main'?'':'<button class="ico" data-del="'+App.esc(s.id)+'">🗑</button>')+'</span></div>'; });
    h+='</div>';
    var d=document.createElement('div'); d.className='overlay'; d.innerHTML=h; document.body.appendChild(d);
    d.addEventListener('click',function(e){ if(e.target===d) d.remove(); });
    d.querySelector('#newsess').addEventListener('click',function(){ App.api('/api/chat/sessions',{method:'POST',body:JSON.stringify({botId:null,mode:'chat',title:'New chat'})}).then(function(r){ cur=r.session; d.remove(); render(root); }); });
    Array.prototype.forEach.call(d.querySelectorAll('.sessrow > span:first-child'),function(el){ el.addEventListener('click',function(){ cur=sessions.filter(function(s){return s.id===el.parentNode.getAttribute('data-id');})[0]; d.remove(); render(root); }); });
    Array.prototype.forEach.call(d.querySelectorAll('[data-ren]'),function(el){ el.addEventListener('click',function(){ var t=prompt('Rename session'); if(t) App.api('/api/chat/sessions/rename',{method:'POST',body:JSON.stringify({id:el.getAttribute('data-ren'),title:t})}).then(function(){ d.remove(); render(root); }); }); });
    Array.prototype.forEach.call(d.querySelectorAll('[data-del]'),function(el){ el.addEventListener('click',function(){ App.api('/api/chat/sessions/delete',{method:'POST',body:JSON.stringify({id:el.getAttribute('data-del')})}).then(function(){ if(cur&&cur.id===el.getAttribute('data-del')) cur=null; d.remove(); render(root); }); }); });
  }
  App.registerView('chat', { label:'Chat', icon:'💬', owner:true, render:function(root){ render(root); } });
})();
`, css: `
.msgs{display:flex;flex-direction:column;gap:8px;padding:8px 0 120px;overflow:auto}
.bubble{max-width:84%;padding:9px 12px;border-radius:16px;white-space:pre-wrap;word-break:break-word;animation:viewIn .18s ease}
.bubble.user{align-self:flex-end;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border-bottom-right-radius:5px}
.bubble.ai{align-self:flex-start;background:var(--glass);border:1px solid var(--glass-brd);border-bottom-left-radius:5px}
.composer{position:fixed;left:10px;right:10px;bottom:calc(64px + env(safe-area-inset-bottom));display:flex;gap:8px;padding:8px;border-radius:18px;align-items:flex-end}
.composer textarea{flex:1;background:transparent;border:none;color:var(--txt);font:inherit;resize:none;max-height:120px;outline:none}
.send{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff;width:38px;height:38px;border-radius:50%;cursor:pointer}
.overlay{position:fixed;inset:0;background:#0008;display:flex;align-items:flex-end;z-index:50}
.drawer{width:100%;max-height:70vh;overflow:auto;border-radius:18px 18px 0 0;padding:12px}
` }
```
Register `chatView` in `frontend/index.ts`'s `assemble([...])`. Add a "Chat about this bot" button in `views/fleet.ts` detail that does `App.api('/api/chat/sessions',{method:'POST',body:JSON.stringify({botId:m.id,mode:'ask',title:m.name})}).then(...)` then `App.go('chat')`.

- [ ] **Step 12: Build + commit**

```bash
npm run typecheck && npm run build
git add src/main/core/miniapp/sessions.ts src/main/core/miniapp/routes/chat.ts src/main/core/miniapp/routes/index.ts src/main/core/miniapp/frontend/views/chat.ts src/main/core/miniapp/frontend/index.ts src/main/core/__tests__/miniapp.sessions.test.ts src/main/core/__tests__/miniapp.chat.test.ts
git commit -m "feat(miniapp): AI chat with persistent multi-session (main + per-bot)"
```

---

### Task 5: Bot import / remove / upload

**Files:**
- Create: `src/main/core/miniapp/routes/bots.ts`
- Create: `src/main/core/miniapp/frontend/views/botsManage.ts`
- Modify: `routes/index.ts`, `frontend/index.ts`, `views/fleet.ts` (add Remove button on detail)
- Test: `src/main/core/__tests__/miniapp.bots.test.ts`

**Interfaces:**
- Produces: `export const botRoutes: Route[]` with `POST /api/bots/import {url}`, `POST /api/bots/remove {id,confirm}`, `POST /api/bots/upload` (raw body).
- Consumes: `sup.importBot(req,log)`, `sup.removeBot(id)`.

- [ ] **Step 1: Failing test** — `miniapp.bots.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { botRoutes } from '../miniapp/routes/bots'
describe('bot routes', () => {
  it('registers import/remove/upload owner-only', () => {
    for (const p of ['/api/bots/import','/api/bots/remove','/api/bots/upload'])
      expect(botRoutes.find((r) => r.path === p)?.ownerOnly).toBe(true)
  })
  it('remove requires confirm:true', async () => {
    const json = vi.fn()
    await botRoutes.find((r) => r.path === '/api/bots/remove')!.handler({ body: { id: 'x', confirm: false }, json } as any)
    expect(json).toHaveBeenCalledWith(400, expect.objectContaining({ error: expect.any(String) }))
  })
})
```

- [ ] **Step 2: Run, verify fail** → FAIL.

- [ ] **Step 3: Implement `routes/bots.ts`**:

```ts
import * as sup from '../../supervisor'
import type { Route, RouteCtx } from './index'

async function importBot(c: RouteCtx): Promise<void> {
  const url = String((c.body as any).url ?? '').trim()
  if (!/^https?:\/\//.test(url)) return c.json(400, { error: 'provide a git URL' })
  try { const { bot } = await sup.importBot({ type: 'git', source: url } as Parameters<typeof sup.importBot>[0]); c.json(200, { ok: true, id: bot.manifest.id }) }
  catch (e) { c.json(500, { error: String((e as Error)?.message ?? e) }) }
}
async function removeBot(c: RouteCtx): Promise<void> {
  const b = c.body as { id?: string; confirm?: boolean }
  if (b.confirm !== true) return c.json(400, { error: 'confirm required' })
  try { await sup.removeBot(String(b.id)); c.json(200, { ok: true }) }
  catch (e) { c.json(500, { error: String((e as Error)?.message ?? e) }) }
}
async function uploadBot(c: RouteCtx): Promise<void> {
  // Body is the raw .zip bytes (service passes rawBody for this path — see note).
  c.json(501, { error: 'zip upload via desktop for now' }) // v1: stub; wire when service raw-body lands
}

export const botRoutes: Route[] = [
  { method: 'POST', path: '/api/bots/import', ownerOnly: true, handler: importBot },
  { method: 'POST', path: '/api/bots/remove', ownerOnly: true, handler: removeBot },
  { method: 'POST', path: '/api/bots/upload', ownerOnly: true, handler: uploadBot }
]
```
Verify the `ImportRequest` shape in `supervisor.ts` (`type:'git'|'local'`, field `source`/`url`); fix the `importBot` arg to match real types so typecheck passes. Upload is stubbed for v1 (multipart needs a raw-body path in `service.ts`); note it in the PR and the UI.

- [ ] **Step 4: Register** in `routes/index.ts` (`...botRoutes`).

- [ ] **Step 5: Write `views/botsManage.ts`** — a "Bots" tab: a text input + "Import from URL" button calling `/api/bots/import`, then `App.refresh()` + `App.go('fleet')`. Add a **Remove** button (with a confirm step) on the bot-detail card in `views/fleet.ts` calling `/api/bots/remove {id,confirm:true}`. Full JS analogous to existing button wiring; use `App.toast`.

- [ ] **Step 6: Tests + build** — `npx vitest run src/main/core/__tests__/miniapp.bots.test.ts && npm run typecheck && npm run build` → PASS.

- [ ] **Step 7: Commit** — `git commit -m "feat(miniapp): import bot from git URL + remove bot"`.

---

### Task 6: Git update / push / apply

**Files:**
- Create: `src/main/core/miniapp/routes/git.ts`
- Modify: `routes/index.ts`, `views/fleet.ts` (buttons on detail), `frontend/views/settings.ts` (Apply button)
- Test: `src/main/core/__tests__/miniapp.git.test.ts`

**Interfaces:**
- Produces: `export const gitRoutes: Route[]` — `POST /api/git/update {id}`, `POST /api/git/push {id}`, `POST /api/git/apply`.
- Consumes: `sup.updateBot(id,log)`, `sup.pushLive(id,log,token?)`, `getGithubToken()` (find exact getter via grep), and an exec for apply.

- [ ] **Step 1: Failing test** — assert the three routes exist + owner-only (pattern as Task 5). Run → FAIL.

- [ ] **Step 2: Implement `routes/git.ts`**:

```ts
import * as sup from '../../supervisor'
import type { Route, RouteCtx } from './index'

async function update(c: RouteCtx) { try { const bot = await sup.updateBot(String((c.body as any).id), () => {}); c.json(200, { ok: true, sha: (bot as any).sha ?? null }) } catch (e) { c.json(500, { error: String((e as Error).message) }) } }
async function push(c: RouteCtx) { try { const r = await sup.pushLive(String((c.body as any).id), () => {}); c.json(200, { ok: true, ...r }) } catch (e) { c.json(500, { error: String((e as Error).message) }) } }
async function apply(c: RouteCtx) {
  const { spawn } = await import('node:child_process')
  const home = process.env.SENTINEL_HOME || process.cwd()
  const child = spawn('/bin/bash', ['-lc', 'npm run typecheck && npm run build'], { cwd: home })
  let out = ''
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d))
  child.on('exit', (code) => c.json(code === 0 ? 200 : 500, code === 0 ? { ok: true } : { error: 'build failed', tail: out.slice(-1500) }))
}
export const gitRoutes: Route[] = [
  { method: 'POST', path: '/api/git/update', ownerOnly: true, handler: update },
  { method: 'POST', path: '/api/git/push', ownerOnly: true, handler: push },
  { method: 'POST', path: '/api/git/apply', ownerOnly: true, handler: apply }
]
```
For `push`, pass the GitHub token if `pushLive` needs it explicitly — grep `grep -rn "githubToken\|getGithubToken\|GITHUB_TOKEN" src/main/core/config.ts` and pass it as the 3rd arg. `apply` does not auto-restart (matches bot behavior: rebuild only; KeepAlive picks up new `out/` on next agent restart) — surface that in the UI copy.

- [ ] **Step 3: Register + UI** — add `...gitRoutes`. In `views/fleet.ts` detail, add **Update** (git bots), **Push** buttons; in `views/settings.ts` add an **Apply (rebuild Sentinel)** button with a confirm + "restart from desktop or it'll pick up on next agent cycle" note.

- [ ] **Step 4: Tests + build + commit** — `git commit -m "feat(miniapp): git update, push-to-live, rebuild Sentinel"`.

---

### Task 7: AI connection test

**Files:**
- Create: `src/main/core/miniapp/routes/agentTest.ts`
- Modify: `routes/index.ts`, `frontend/views/settings.ts` (Test button)
- Test: `src/main/core/__tests__/miniapp.agentTest.test.ts`

**Interfaces:**
- Produces: `export const agentTestRoutes: Route[]` — `POST /api/agent/test`.
- Consumes: `getAgentConfig()`, `ping(p)` from `agent/provider.ts`.

- [ ] **Step 1: Failing test**:

```ts
import { describe, it, expect, vi } from 'vitest'
import { agentTestRoutes } from '../miniapp/routes/agentTest'
describe('agent test route', () => {
  it('is owner-only and returns ok=false when unconfigured', async () => {
    const r = agentTestRoutes.find((x) => x.path === '/api/agent/test')!
    expect(r.ownerOnly).toBe(true)
    const json = vi.fn()
    await r.handler({ body: {}, json } as any)
    expect(json).toHaveBeenCalledWith(200, expect.objectContaining({ ok: expect.any(Boolean) }))
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `routes/agentTest.ts`**:

```ts
import { getAgentConfig } from '../../config'
import { ping } from '../../agent/provider'
import type { Route } from './index'
export const agentTestRoutes: Route[] = [
  { method: 'POST', path: '/api/agent/test', ownerOnly: true, handler: async (c) => {
    const a = getAgentConfig()
    if (!a.ready) return c.json(200, { ok: false, error: 'not configured' })
    try { const ok = await ping({ baseUrl: a.baseUrl, apiKey: a.apiKey, model: a.model }); c.json(200, { ok, model: a.model }) }
    catch (e) { c.json(200, { ok: false, error: String((e as Error).message) }) }
  } }
]
```

- [ ] **Step 4: Register + UI** — `...agentTestRoutes`; in `views/settings.ts` AI card add a **Test connection** button → `App.api('/api/agent/test',{method:'POST',body:'{}'})` → `App.toast(r.ok?'Connected ✓':'Failed: '+r.error, r.ok?'ok':'err')`.

- [ ] **Step 5: Tests + build + commit** — `git commit -m "feat(miniapp): test AI provider connection"`.

---

### Task 8: User-approval management

**Files:**
- Create: `src/main/core/miniapp/routes/users.ts`
- Create: `src/main/core/miniapp/frontend/views/users.ts` (or a Settings card)
- Modify: `routes/index.ts`, `frontend/views/settings.ts`
- Test: `src/main/core/__tests__/miniapp.users.test.ts`

**Interfaces:**
- Produces: `export const userRoutes: Route[]` — `GET /api/users`, `POST /api/users/approve {userId}`, `POST /api/users/revoke {userId}`.
- Consumes: `getApprovedUsers()`, `approveUser(id)`, `rejectUser(id)`.

- [ ] **Step 1: Failing test**:

```ts
import { describe, it, expect, vi } from 'vitest'
import { userRoutes } from '../miniapp/routes/users'
describe('user routes', () => {
  it('GET /api/users lists approved; approve/revoke owner-only', () => {
    expect(userRoutes.find((r) => r.path === '/api/users' && r.method === 'GET')?.ownerOnly).toBe(true)
    expect(userRoutes.find((r) => r.path === '/api/users/approve')?.ownerOnly).toBe(true)
    expect(userRoutes.find((r) => r.path === '/api/users/revoke')?.ownerOnly).toBe(true)
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `routes/users.ts`**:

```ts
import { getApprovedUsers, approveUser, rejectUser } from '../../config'
import type { Route } from './index'
export const userRoutes: Route[] = [
  { method: 'GET', path: '/api/users', ownerOnly: true, handler: (c) => c.json(200, { approved: getApprovedUsers() }) },
  { method: 'POST', path: '/api/users/approve', ownerOnly: true, handler: (c) => { approveUser(Number((c.body as any).userId)); c.json(200, { ok: true, approved: getApprovedUsers() }) } },
  { method: 'POST', path: '/api/users/revoke', ownerOnly: true, handler: (c) => { rejectUser(Number((c.body as any).userId)); c.json(200, { ok: true, approved: getApprovedUsers() }) } }
]
```
(`getApprovedUsers` returns IDs only; a pending-request list isn't persisted as a queryable store, so v1 exposes approved-list management + manual approve-by-ID. Note this limitation in the UI.)

- [ ] **Step 4: Register + UI** — `...userRoutes`; add an **Access** card in `views/settings.ts` (owner-only) listing approved user IDs with a **Revoke** button each, and an input + **Approve ID** button. Use `App.api`/`App.toast`.

- [ ] **Step 5: Tests + build + commit** — `git commit -m "feat(miniapp): manage approved users"`.

---

## Integration & deploy (lead, after Wave 2)

- [ ] Merge all Wave-2 branches; resolve the two shared files (`routes/index.ts` aggregation, `frontend/index.ts` `assemble([...])` list) so every `...Routes` and every `*View` is included once.
- [ ] Full gate: `npm run typecheck && npm test && npm run build` → all green.
- [ ] Restart live agent: `launchctl kickstart -k gui/$(id -u)/com.sentinel.monitor`.
- [ ] Verify in `~/Documents/Sentinel/logs/monitor.out.log`: `[miniapp] dashboard on …`, `tunnel up`, `menu button set`. Open from the bot's menu button; confirm chat streams, sessions persist across a restart, and each new feature works. `curl https://<sub>.trycloudflare.com/health` → `{"ok":true}`; `/api/state` 401 without initData.

---

## Self-Review

**Spec coverage:** §2 session model → Task 4 (`sessions.ts`). §3 AI execution (chat/ask) → Task 4 `routes/chat.ts`. §4 reuse backend → Tasks 4–8 consume real signatures. §5 fetch+SSE transport → Task 4 stream handler + chat view reader. §6 modular frontend/routes → Tasks 1–3. §7 all five features → Tasks 4–8. §8 wave execution → Wave 1 gate + Wave 2 parallel + Integration. §9 error handling/tests → each task ships tests; owner-only asserted. §10 out-of-scope (`fix`, assets, desktop) → respected (chat modes limited to `chat`/`ask`; embedded strings; no desktop edits).

**Placeholder scan:** Two deliberate, flagged stubs — `uploadBot` (501; needs a raw-body path in `service.ts`, out of v1 scope) and the `/* port ... */` in Task 3 Step 3 which the step explicitly instructs to expand from cited line ranges. Three grep-discovery steps (data-dir symbol, GitHub-token getter, `ImportRequest` shape) are reconnaissance against real code, not code placeholders.

**Type consistency:** `RouteCtx`/`Route` defined in Task 1 and consumed identically in Tasks 4–8. `ChatSession`/`MAIN_ID`/store fns named identically across `sessions.ts`, `routes/chat.ts`, and tests. `App.*` client API defined in Task 2 and used by every view. Provider shape `{baseUrl,apiKey,model}` consistent with `getAgentConfig()` and `chatStream`/`ping`. Tasks note where real `runAgent`/`importBot`/`pushLive` signatures must be confirmed and adapted so typecheck passes.
