# Sentinel Mini App — AI Chat, Sessions, Feature Parity & Redesign

**Date:** 2026-06-23
**Status:** Approved design (pending spec review)

## 1. Goal

Bring the Sentinel Telegram Mini App (the in-Telegram dashboard GUI) to feature
parity with the Telegram control bot, with an AI chat experience modeled lightly
on Claude Code's session system, and a full UI redesign (modern dark
glassmorphic) with rich animation.

The Mini App today covers monitoring + basic lifecycle (fleet status, per-bot
start/stop/restart, autostart, log tail, env editor, settings). It is missing:
AI chat/agent, bot import/remove/upload, git update/push/apply, AI-connection
test, and user-approval management. This project adds all of them.

## 2. "How Claude Code works" → what we mirror (lightly)

Claude Code model: every conversation is a **session** with a unique id and a
persisted transcript that survives restarts; you **continue** the most recent by
default or **resume/pick** any past session (each has an auto-title + timestamp);
sessions are **scoped to a project directory**; you can **rename** and **clear**
them.

**We keep:** sessions as persisted chat threads; continue-by-default;
list/resume/rename/delete; scoping into a global **Main** session vs **per-bot**
sessions (many allowed per bot).

**We drop (YAGNI):** compaction, branching, checkpoints, full transcript-replay
UI, multi-directory scoping.

## 3. Session model

New store: `src/main/core/miniapp/sessions.ts`, persisted to
`~/.sentinel/miniapp-sessions.json` (resolved via `DATA_HOME`, same convention as
`agent/memory.ts`), owner-scoped.

```ts
interface ChatSession {
  id: string                       // uuid (node:crypto.randomUUID)
  title: string                    // default "New chat"; "Main" for the root
  botId: string | null             // null = global/Main; else bound to a bot
  mode: 'chat' | 'ask'             // 'fix' deferred to a follow-up
  messages: { role: 'user' | 'assistant'; content: string; ts: number }[]
  createdAt: number
  updatedAt: number
}
```

- **Main session:** always present (stable id `main`), `botId: null`,
  `mode: 'chat'`. Not deletable; can be **reset** (clears messages). New chats
  default to continuing Main.
- **Per-bot sessions:** created from a bot's detail view ("Chat about this
  bot"). v1 mode is always `ask` (read-only investigation). Many per bot.
- **Operations:** `listSessions(botId?)`, `createSession({botId, mode, title?})`,
  `renameSession(id, title)`, `deleteSession(id)`, `resetSession(id)`,
  `getSession(id)`, `appendTurn(id, user, assistant)`.
- **Limits:** reuse the per-thread caps from `agent/memory.ts` (max ~16 turns /
  ~14k chars), applied per session; oldest turns dropped first.

## 4. AI execution (reuse existing backend)

No new LLM code. Reuse `src/main/core/agent/`:

- **`mode:'chat'` (Main):** `chatStream(provider, messages, onText, signal)` —
  token streaming, no tools. Mirrors `/ai`.
- **`mode:'ask'` (per-bot):** `runAgent({ provider, botId, dir, task,
  allowWrites:false, scope:'bot', history, events })` — tool-calling loop over
  read-only tools (`read_file`, `read_logs`, `get_status`, `search_code`,
  `read_env_example`, `check_updates`, `list_files`). Its `events.onText`,
  `onTool`, `onToolResult` are streamed to the client as step events so it feels
  live. Read-only ⇒ no approval gate.
- **`mode:'fix'` — explicitly deferred.** v1 ships no web-approval mechanism.

Provider comes from `getAgentConfig()` (already reachable in the service). If
`!provider.ready`, chat endpoints return a clear "AI not configured" error that
the UI links to Settings.

## 5. Streaming transport

Streaming uses **`fetch()` POST** returning a chunked `text/event-stream`
response; the client reads via `response.body.getReader()` + `TextDecoder`.

Rationale: `EventSource` cannot set the `X-Tg-Init-Data` header that carries
Telegram initData HMAC auth, and cannot POST a body. `fetch` keeps the existing
header-based auth model and supports POST. node:http streams via `res.write()`.

Event framing (one JSON object per `data:` line):
```
data: {"type":"delta","text":"..."}      // chat token chunk (full text so far)
data: {"type":"tool","name":"read_logs","args":{...}}   // ask step
data: {"type":"tool_result","name":"read_logs","result":"..."}
data: {"type":"done","content":"<final assistant text>"}
data: {"type":"error","message":"..."}
```
Client aborts via `AbortController`; server aborts the agent via the `signal`
passed into `runAgent`/`chatStream`. On `done`, both client and server persist
the turn via `appendTurn`.

## 6. Frontend architecture (parallel-safe, no build changes)

**Constraint:** electron-builder ships `out/**/*` only; electron-vite bundles the
main process into JS and will not copy a loose `public/` asset folder without new
build config. Therefore the frontend stays **embedded as TS strings** (guaranteed
to package) but is **split into fragment modules** so parallel agents own
isolated files.

Restructure `src/main/core/miniapp/frontend.ts` →
`src/main/core/miniapp/frontend/`:

- `frontend/index.ts` — assembles `MINIAPP_HTML` from the fragments (HEAD +
  design-system CSS + per-view CSS + body shell + per-view HTML + shared JS +
  per-view JS). Exports the same `MINIAPP_HTML` symbol the service imports today.
- `frontend/shell.ts` — layout, **bottom tab bar**, the glassmorphic **design
  system** (CSS custom-property tokens: surfaces, blur, gradient accents, glow,
  spacing, radii, type scale), **animation primitives** (view/tab transitions,
  spring micro-interactions, skeleton shimmer, animated status dots, streaming
  cursor / typing dots), a small client-side **view registry** (`App.registerView`
  + `App.go`), the shared `api(path, opts)` fetch+auth helper (injects
  `X-Tg-Init-Data`), and toast/skeleton components.
- `frontend/views/{fleet,botDetail,settings,chat,botsManage,users}.ts` — one
  module per feature view; each self-registers with the shell and renders into a
  shell-provided container.

JS convention: keep the existing no-backtick / no-`${}` rule inside the embedded
strings (string concatenation with `+`), since fragments are themselves inside TS
template strings.

Backend mirrors this. `service.ts` stays a thin HTTP server + auth + dispatcher.
Route handlers move to `src/main/core/miniapp/routes/`:
- `routes/index.ts` — exports a route table:
  `{ method, pattern, handler, ownerOnly }[]`. Single small merge point.
- `routes/{state,chat,bots,git,agentTest,users}.ts` — one module per concern.
- Each handler receives a context `{ req, res, url, auth:{userId,isOwner}, body }`
  plus direct access to `supervisor`/`config` via imports (unchanged pattern).

## 7. Features delivered

All gated owner-only on mutation (existing HMAC + isOwner check). New endpoints:

### Chat + sessions — `routes/chat.ts` + `sessions.ts` + `views/chat.ts`
- `GET  /api/chat/sessions?botId=` → list sessions (Main + matching).
- `POST /api/chat/sessions` → create `{ botId, mode, title? }`.
- `POST /api/chat/sessions/rename` → `{ id, title }`.
- `POST /api/chat/sessions/delete` → `{ id }` (Main rejected; use reset).
- `POST /api/chat/sessions/reset` → `{ id }`.
- `POST /api/chat/stream` → `{ id, message }` → chunked `text/event-stream`.
- UI: **Chat tab** with a session drawer (list, new, rename, delete, switch),
  message bubbles, streaming text with cursor, typing dots during tool steps,
  per-bot "Chat about this bot" entry point from bot detail.

### Bot import / remove / upload — `routes/bots.ts` + `views/botsManage.ts`
- `POST /api/bots/import` → `{ url }` (git clone/import; reuse the bot's
  clone/import core path).
- `POST /api/bots/remove` → `{ id, confirm:true }` (2-step confirm in UI).
- `POST /api/bots/upload` → multipart/octet-stream `.zip` import or file-add to a
  selected bot.
- UI: **"+ Add bot"** (paste git URL / upload zip) + **Remove** (confirm) on
  detail.

### Git / deploy — `routes/git.ts` + botDetail buttons
- `POST /api/git/update` → `{ id }` (git pull + reinstall + restart).
- `POST /api/git/push` → `{ id }` (push to `sentinel-live`; needs GitHub token).
- `POST /api/git/apply` → rebuild & restart Sentinel.
- UI: **Update / Push / Apply** actions where relevant.

### AI connection test — `routes/agentTest.ts` + settings button
- `POST /api/agent/test` → makes a minimal `chatCompletion` round-trip with the
  configured provider; returns `{ ok, model, error? }`.
- UI: **Test connection** button in Settings → AI section.

### User-approval management — `routes/users.ts` + `views/users.ts`
- `GET  /api/users` → `{ approved:[...], pending:[...] }`.
- `POST /api/users/approve` → `{ userId }`.
- `POST /api/users/revoke` → `{ userId }`.
- UI: approved/pending lists with approve/revoke in Settings.

## 8. Execution plan (post-approval)

**Wave 1 (solo, lands first — foundational gate):** build `frontend/shell.ts`
(design system + animation framework + view registry + `api()` helper), the
`frontend/index.ts` assembler, the `routes/index.ts` table + thinned `service.ts`,
and re-skin the existing Fleet / BotDetail / Settings views into the new system.
Verify `typecheck && test && build` green. This establishes every convention
Wave 2 depends on.

**Wave 2 (parallel — one agent per feature, isolated files):** the five features
in §7, each owning its own `routes/<feature>.ts` (+ `sessions.ts` for chat) and
`views/<feature>.ts`. Integration merge points owned by the lead: `routes/index.ts`
(register handlers) and shell tab registration.

**Gate before live deploy:** `npm run typecheck && npm test && npm run build`
clean, then restart the live agent via
`launchctl kickstart -k gui/$(id -u)/com.sentinel.monitor` and verify
`[miniapp]` log lines + tunnel up + menu button.

## 9. Error handling & testing

- Every mutation owner-only; non-owner/forged initData → 401 (existing).
- Stream errors emit `{type:"error"}` rendered inline; `AbortController` cancels
  in-flight turns; provider-not-ready returns a Settings deep-link error.
- Each feature ships vitest tests next to the existing `miniapp.test.ts`
  (`miniapp.sessions.test.ts`, `miniapp.chat.test.ts`, etc.): session CRUD +
  persistence, auth gating per endpoint, stream framing, owner-only enforcement.

## 10. Out of scope

- `mode:'fix'` / acting chat + web-approval mechanism (follow-up).
- Real-asset-file serving (packaging risk); WebSockets; session
  branching/compaction.
- Desktop GUI changes.
- `control.enabled` and `backgroundAgent` remain read-only from the phone
  (toggling either would kill the dashboard).
