# Sentinel — Improvements & Roadmap

> Single source of truth for planned Mini App + Bot improvements. Grounded in the
> current codebase (file paths and data shapes are real). Effort tags: **S**
> (≤½ day), **M** (1–2 days), **L** (3+ days). "FE" = frontend-only (Mini App),
> "BE" = needs backend/data work.

---

## 0. What the runtime already gives us (grounded baseline)

Every bot returned by `GET /api/state` (→ `supervisor.listBots()` → `runtimeOf()`
in `src/main/core/supervisor.ts`) carries a `runtime` object:

| Field | Source | Notes |
|---|---|---|
| `status` | launchctl | `running` / `crashed` / `crash-looping` / `stopped` / … |
| `pid` | launchctl | null when stopped |
| `restarts` | launchctl runs | |
| `cpu` | `stats.ts procStat` | **% of one core. Lifetime-avg in the list path (`sampleMs=0`)** — not instantaneous. |
| `memMB` | `stats.ts procStat` | RSS in MB. **Already collected, not shown per-graph.** |
| `memPct` | `stats.ts procStat` | RSS as % of total system RAM. **Collected, never rendered.** |
| `uptime` | `ps etime` | **String** (`"02:59"`, `"1-03:04:05"`). Parse with existing `cputimeToSec()`. |
| `installed`, `envReady`, `envFilePresent`, `updatesBehind` | — | |

**Three facts that drive the designs below:**
1. **CPU + memPct are already in the payload** — surfacing them is FE-only.
2. **List CPU is a lifetime average**, so a *live* CPU graph needs a real sampler
   (`procStat(pid, 1000)` diffs CPU-time over a window — see `stats.ts`).
3. **No metric history is stored anywhere** — graphs need a ring buffer (client or server).

---

## ✅ Shipped log

- **2026-06-24 — Raycast redesign** (full dark command-palette UI), emoji → inline SVG icons, role-based settings (non-owner read-only summary + banner), real toggle switches.
- **2026-06-24 — Batch 1:** §1.1 fleet **sorting + filtering**, §1.3 **adaptive uptime** ticker, **CPU%/mem%** surfaced, §1.2-A **client sparklines**, `App.confirm`/`App.prompt` **modals**, chat **rename (B1)** / **delete (B2)** / **clear (B5)** fixed, backend `uptimeSec`.
- **2026-06-24 — Batch 2:** §2.4 API-key **visibility toggle**, §2.6 auto-approve **Safe/Dangerous badges**, **§7 Hermes managers v1** — per-bot agent can now ACT (gated on owner + auto-approve), "Open manager" entry, `mode` SSE event.
- **2026-06-24 — Batch 3 (parallel agents):**
  - **§1.2-B Graphs Tier B** — server-side metric ring buffer in `monitor.ts` tick (no extra `ps`), `GET /api/metrics`, detail view polls every 3s → live CPU/mem sparklines.
  - **§3.1 Crash push alerts** — owner gets a crash notification with **Restart / Logs / Mute 1h** inline buttons (`mute:<id>` callback + in-memory mute state); reuses existing `do:restart:`/`logs:` handlers.
  - **§7 per-action confirm over SSE** — owner can now let the manager act **without** YOLO: each mutating tool fires an `App.confirm` on the phone via a `{type:'confirm',token}` SSE event + `POST /api/chat/confirm` side-channel (120s timeout + disconnect-safe). Gating: non-owner read-only · owner+YOLO acts now · owner+!YOLO confirms each action.
  - **§8.2 Fleet-scope Main chat** — Main chat is now a read-only **fleet agent** (`list_bots`/`get_bot_status`/`read_bot_logs`, new `'fleet'` scope) instead of a contextless LLM — it can actually answer "are the bots healthy?" with specifics. _This is the real fix for the generic-AI-answer screenshot._
- **2026-06-24 — Batch 4 (follow-ups + hardening):**
  - **Manager session reuse** — "Open manager" now get-or-creates (reuses the bot's existing `ask` session instead of spawning a new one per tap). _(Supersedes the "auto-create on import" idea — cleaner UX, no backend change.)_
  - **Mute persistence** — crash-alert mutes now survive a restart (`crash-mutes.json` under DATA_HOME; expired entries pruned on load).
  - **§4.3 Cache-busting** — menu-button URL carries `?v=<html-hash>` + the served HTML sends `Cache-Control: no-store`, so a rebuild no longer shows stale UI in Telegram's WebView.
  - **§4.5 Toast cap** — toasts capped at 3 with exact-duplicate collapse.
  - **§4.9 Error boundary** — `go()` wraps `v.render()` in try/catch → friendly error card + Reload instead of a blank screen.
  - **§4.4** (shared ticker cleanup) was already satisfied by `App.viewTimer`/`clearViewTimers` in Batch 1.
  - **Per-bot agent memory namespace** — already covered: `agent/memory.ts` keys by `bot:<id>` thread, and Mini App managers carry per-bot history via their `botId`-scoped session. No new code needed.

- **2026-06-24 — Batch 5 — §5.3 User identity + pending queue** (unblocks §2.7/§2.8/§3.6):
  - **Identity capture** — the bot records `{id, firstName, lastName, username, requestedAt, approvedAt}` for every user (cheap upsert on each message; backfills names for already-approved users). Stored in `config.json` (`userProfiles` + `pendingUsers`).
  - **Pending queue** — `/start` access requests are now persisted, so they appear in the Mini App, not just the Telegram approve/reject buttons (**/approve ↔ Mini App parity**). Approve moves pending→approved (stamps `approvedAt`); reject/revoke drop + ignore.
  - **API** — `GET /api/users` → `{approved: UserProfile[], pending: UserProfile[]}`; added `POST /api/users/reject`.
  - **UI** — Settings → Access now shows a **pending-requests block** (Approve / Reject) and an **approved list** with **avatar monograms, real names, @handles, and relative timestamps** (Revoke behind an `App.confirm`).
  - _Follow-up: real profile photos (needs `getUserProfilePhotos` + file download) — currently initials monograms._

- **2026-06-24 — Batch 6 (credential health + parallel agents):**
  - **§5.2 → Credential health** (reframed: tokens don't expire, so check *validity* instead) — `POST /api/health/credentials` live-checks the **bot token** (`getMe`), **GitHub token** (`/user` + repo-scope note), and **AI key** (`ping`); Settings → "Credential health" card with a Check button and OK/Fail badges.
  - **§2.2 Live log tail + search** — detail Logs panel auto-refreshes every 2s (Pause/Resume), with a search filter, match highlighting, level coloring, and scroll-pinning.
  - **§2.9 Bulk fleet actions** — owner-only Start/Stop/Restart-all over the current filtered list, sequential, behind `App.confirm`.
  - **§3.8 Update nudges + §4.1 `updatesBehind`** — new leaf `updates.ts` cache (the only place that does `git fetch` + counts commits-behind), read by `supervisor.runtimeOf` (the dead field is now live) and refreshed by `monitor.ts` every 30 min, which DMs the owner "Update now / Logs" when new commits appear (once per new batch).
  - **§3.4 Resource-threshold alerts** — sustained CPU ≥90% or mem ≥80% for 3 consecutive ticks → one owner DM (respects mute + notify gating).

### Remaining — larger features / decisions
- **Mini App:** §2.1 command palette, §2.11 health score, §2.12 env diff.
- **Bot:** §3.3 `/metrics` text sparkline, §3.5 scheduled daily/weekly reports.
- **Polish:** real Telegram profile photos in the access list (currently initials), per-action SSE confirm UX refinements.
- **Bigger Mini App features:** §2.1 command palette, §2.2 live log streaming+search, §2.9 bulk actions, §2.11 health score, §2.12 env diff.
- **Bigger Bot features:** §3.3 `/metrics` text sparkline, §3.4 resource-threshold alerts, §3.5 scheduled reports, §3.8 update-available nudges (implement §4.1 `updatesBehind` as part of this).

---

## 1. Requested improvements (this round)

### 1.1 — Fleet sorting & filtering · `views/fleet.ts` · **S, FE**

The fleet list renders `st.bots` in insertion order (`bots.forEach`). Add a
compact control row above the `.botgrid`.

- **Sort pill-tabs** (Raycast `pill-tab` style, already in the design system):
  `Status` · `Name` · `CPU` · `Memory` · `Uptime`. Tapping toggles asc/desc.
- **Sort keys** (all from `runtime`): status priority
  (`crash-looping` > `crashed` > `running` > `stopped`), `manifest.name`
  (localeCompare), `cpu`, `memMB`, `uptimeSec` (see §1.3). Null metrics sort last.
- **Filter chips** (optional, same row): `All` · `Running` · `Issues` (crashed +
  crash-looping) · `Stopped`.
- **Persist** the chosen sort/filter in `App.state` (and optionally
  `localStorage`) so it survives `refresh()` re-renders.
- Default sort = **status priority** (problems float to the top).

### 1.2 — Memory & CPU usage with graphs · `views/fleet.ts` (+ optional BE) · **M**

Two tiers — ship Tier A first, add Tier B if we want true real-time.

**Tier A — client-side sparklines from poll history (FE-only, S→M).**
- Keep a per-bot ring buffer in `App.state.history[botId] = { cpu:[], mem:[] }`,
  pushed on every `refresh()` (cap ~60 points). Already polling — free data.
- Render an inline **SVG sparkline** (reuse the `ic-svg`/inline-SVG pattern from
  `shell.ts`): a `<polyline>` normalized to the card width, hairline stroke,
  `--ok`/`--warn`/`--err` color by latest value vs threshold.
- Surface the unused numbers too: **CPU %**, **Mem MB + memPct**, in the
  `.miniStats` row and on the bot-detail screen.
- Add a small **`App.spark(points, opts)`** helper to `CORE_JS` so both fleet
  cards and detail reuse it.

**Tier B — real-time server metrics (BE, M).**
- New `GET /api/metrics?id=&n=60` in `routes/state.ts` backed by a per-bot
  rolling buffer filled by a sampler that calls `procStat(pid, 1000)` (instantaneous
  CPU) on a timer — **separate from the list path** so we never add latency to
  `listBots()`. The `monitor.ts` tick loop is the natural host.
- Detail view polls `/api/metrics` (e.g. every 2–3 s) only while open; renders a
  larger area/line chart (CPU + Mem dual-axis) with the same SVG approach.
- Add **threshold lines** (e.g. mem 80% of system, CPU 90%) and color the fill
  when breached → ties into §4 resource alerts.

### 1.3 — Adaptive uptime refresh · `views/fleet.ts` + small BE helper · **S**

Goal: the displayed uptime self-updates without re-polling the server, at a
cadence proportional to its magnitude.

- **Numeric anchor:** add `uptimeSec: number | null` to `runtimeOf()` by running
  the existing `cputimeToSec(uptime)` on the `etime` string (zero new sampling).
  Client then holds `startedAtMs = Date.now() - uptimeSec*1000` per bot and
  recomputes locally between polls (drift-free across the 2–3 s poll).
- **Cadence ladder** (one tick = the unit below the current magnitude):

  | Uptime | Re-render every |
  |---|---|
  | < 1 minute | **1 s** |
  | < 1 hour | **1 min** |
  | < 1 day | **1 hour** *(display flips m→h)* |
  | ≥ 1 day | **1 hour** (days rarely change; hourly keeps the `Xd Yh` honest) |

- **One shared ticker, not N timers:** a single `setInterval(1000)` walks visible
  bot cards, recomputes elapsed, and only writes the DOM text when the formatted
  string changes (cheap; respects `prefers-reduced-motion` — it's text, not anim).
- **Lifecycle:** start on view mount, `clearInterval` on `go()` away / detail open,
  so we never leak timers across view switches.
- **Formatter:** `<60s → "Ns"`, `<60m → "Nm"`, `<24h → "Hh Mm"`, else `"Dd Hh"`.

---

## 2. New features — Mini App

| # | Feature | Why | Where | Effort |
|---|---|---|---|---|
| 2.1 | **Command palette (⌘K-style search)** | The whole UI is Raycast — a fuzzy "jump to bot / run action" overlay is the signature interaction and we already have the bottom-sheet/overlay primitives in `chat.ts`. | new `views/palette.ts` + topbar trigger | M |
| 2.2 | **Live log streaming + search** | `/api/logs` is pull-only (`tailBotLogs`). Add SSE stream (mirror `/api/chat/stream`) + an in-box filter field + level highlighting. | `routes/state.ts`, fleet detail | M |
| 2.3 | **Read-only mode banner** | Spec gap: non-owners get disabled inputs with no explanation. Add the persistent gray banner + lock affordance. | `shell.ts` (banner primitive), `settings.ts`, `fleet.ts` | S |
| 2.4 | **API-key visibility toggle** | Settings key field is a bare password input. Add an eye icon (we have the inline-SVG system — add `eye`/`eyeOff`). | `shell.ts` ICONS, `settings.ts` | S |
| 2.5 | **Real confirm modal** | Today destructive actions are 2-tap inline buttons. Add a proper `App.confirm({title,body,danger})` overlay (Cancel + red Confirm) and route Remove/Apply/Push through it. | `shell.ts` (modal primitive) | M |
| 2.6 | **Auto-approve Safe/Dangerous badges** | Spec gap: YOLO toggle has no risk framing. Add green `Safe` / red `Dangerous` badges explaining scope. | `settings.ts` | S |
| 2.7 | **User handles + avatars in Access list** | Today only raw numeric IDs. Cache `@handle`/first name (and optional photo) when a user is approved. | `routes/users.ts` + config store | M (BE) |
| 2.8 | **Pending-requests queue** | No queryable pending queue exists (`users.ts` note). Persist requests + `Approve/Reject` inline. | config + `routes/users.ts` + `settings.ts` | M (BE) |
| 2.9 | **Bulk fleet actions** | Multi-select bots → Start/Stop/Restart all. Useful after a host reboot. | `fleet.ts`, `routes/state.ts` | M |
| 2.10 | **Pull-to-refresh + last-updated stamp** | Mobile-native gesture; show "updated 3s ago" so stale data is obvious. | `shell.ts` | S |
| 2.11 | **Per-bot health score** | Roll up restarts + crash history + uptime into a 0–100 chip; sortable (ties into §1.1). | `fleet.ts`, derive in `runtimeOf` | M |
| 2.12 | **Env editor improvements** | Diff view (changed keys highlighted), validation, "copy to clipboard", reveal-one secret. | `fleet.ts` env box | M |
| 2.13 | **Empty-state onboarding** | First-run: guided "import your first bot" with the Git flow front-and-center. | `botsManage.ts` | S |

---

## 3. New features — Bot (Telegram control bot)

| # | Feature | Why | Where | Effort |
|---|---|---|---|---|
| 3.1 | **Crash push notifications w/ inline actions** | `notify.ts` exists; on crash send a message with `Restart`/`Logs`/`Mute 1h` inline buttons (we already handle inline buttons elsewhere). | `monitor.ts` → `notify.ts`, `telegramBot.ts` | M |
| 3.2 | **`/status` quick digest** | One command → all bots: status dot, CPU/mem, uptime, restarts. Mirrors fleet but in chat. | `telegramBot.ts` | S |
| 3.3 | **`/metrics <bot>`** | Text sparkline (Unicode blocks ▁▂▃▅▇) of recent CPU/mem from the §1.2-B buffer. | `telegramBot.ts` + metrics buffer | M |
| 3.4 | **Resource-threshold alerts** | Notify when a bot exceeds CPU/mem thresholds for N samples (not just on crash). | `monitor.ts` | M |
| 3.5 | **Scheduled reports** | Daily/weekly fleet summary DM (uptime %, crashes, updates available). | `monitor.ts` cron-ish | M |
| 3.6 | **`/approve` ↔ Mini App parity** | Pending queue (2.8) surfaced in both; approving in one updates the other. | `routes/users.ts`, `telegramBot.ts` | M |
| 3.7 | **Per-bot mute / snooze** | Silence a noisy crash-looper for 1h/until-fixed without disabling alerts globally. | config + `notify.ts` | S |
| 3.8 | **Update-available nudges** | `updatesBehind` is a field but always `null`. Compute it (git rev compare) and DM when a managed git bot has upstream commits, with a one-tap `Update`. | `git.ts`, `monitor.ts` | M |

---

## 4. Fixes & hardening (both surfaces)

| # | Item | Detail | Effort |
|---|---|---|---|
| 4.1 | **`updatesBehind` is dead** | Always `null` in `runtimeOf`. Either implement (git `rev-list --count`) or hide the field until it does something. | S |
| 4.2 | **CPU label is misleading** | List shows lifetime-avg CPU but reads like "current". Label it, or move to the §1.2-B instantaneous sampler. | S |
| 4.3 | **Telegram webview caching** | After a rebuild the Mini App can serve stale HTML. Add a `?v=<buildhash>` cache-bust on the served URL + `Cache-Control` headers. | S |
| 4.4 | **Single shared ticker** | Make sure §1.3 (and any future timers) don't leak across `go()` view switches — centralize timer cleanup in the view registry. | S |
| 4.5 | **Toast queue cap** | Rapid errors can stack many toasts. Cap to ~3 + collapse duplicates. | S |
| 4.6 | **`/api/state` cost** | `runtimeOf` runs `ps` per bot on every poll. With many bots + 2–3 s polling this is N `ps` spawns/cycle. Batch into one `ps` call or cache for ~1 s. | M |
| 4.7 | **Optimistic action UI** | Start/Stop/Restart fully re-render detail after a round-trip. Show an optimistic pending state first. | S |
| 4.8 | **Accessibility pass** | Icon-only buttons need `aria-label` (mostly done in the redesign); verify focus order + contrast of `--hint` on `--canvas`. | S |
| 4.9 | **Error boundary** | A throwing view leaves a blank `#view`. Wrap `v.render()` in try/catch → friendly error card + retry. | S |

---

## 5. Backend/data gaps that unblock the above

These three are the only items needing real server work; everything else is FE or
light wiring:

1. **Metric history buffer** (unblocks 1.2-B, 3.3) — per-bot ring of
   `{ts, cpu, memMB, memPct}` filled by a sampler on the `monitor.ts` tick;
   exposed via `/api/metrics`.
2. **Token-expiry tracking** (Settings spec gap) — `notify.hasToken` is a boolean;
   no expiry is captured. Telegram bot tokens don't expire, so either drop the
   "Expires in N days" concept or repurpose it for the **GitHub token** / agent
   API key health. Decide intent before building UI.
3. **User identity + pending queue** (unblocks 2.7, 2.8, 3.6) — persist
   `{id, handle, name, photo?, approvedAt}` and a pending-request list in config.

---

## 6. Suggested sequencing

1. **Quick wins (1 PR):** §1.1 sorting, §1.3 adaptive uptime, surface CPU/memPct,
   §2.3 read-only banner, §2.4 key toggle, §2.6 risk badges, §4.2/§4.3/§4.5.
2. **Graphs:** §1.2-A client sparklines → §1.2-B server sampler + `/api/metrics`.
3. **Notifications:** §3.1 crash push + §3.7 mute, then §3.4 thresholds.
4. **Identity & access:** §5.3 → §2.7 / §2.8 / §3.6.
5. **Polish:** §2.1 command palette, §2.2 log streaming, §2.5 confirm modal.

---

---

## 7. Per-bot Hermes agents — "a manager per bot"

**Goal:** every managed bot gets its own persistent agent ("Hermes manager") with
its own chat, its own memory, and the ability to actually inspect and fix *that*
bot — instead of one global chatbot that knows nothing.

### What already exists (don't rebuild)
- `agent/runtime.ts` `runAgent({ botId, dir, scope:'bot', allowWrites, history, events })`
  — a full tool-calling agent loop.
- `agent/tools.ts` `TOOLS` — the manager toolset is already implemented:
  `list_files`, `read_file`, `write_file`, `edit_file`, `search_code`,
  `run_command`, `read_logs`, `get_status`, `read_env_example`, `set_env`,
  `setup_env`, `restart_bot`, `stop_bot`, `start_bot`, `check_updates`, `git_pull`.
  Write/action tools are gated by `allowWrites` (`toolSchemasFor`).
- `miniapp/sessions.ts` — per-bot sessions (`botId`, `mode:'ask'`), persisted.
- `agent/memory.ts` — agent memory store.

### The gaps that make it feel like there's "no manager"
1. **Main chat has no tools.** `routes/chat.ts` mode `'chat'` → `chatStream` =
   raw LLM completion, no tools, no bot context. This is the source of the
   "I can't access any infrastructure" answers (see §8).
2. **Per-bot agent is read-only.** The fleet "Chat about this bot" button and the
   `ask` path hard-code `allowWrites:false` → the manager can *read* logs/status
   but cannot restart, fix env, or pull. It can diagnose but not act.
3. **No auto-created manager.** A bot has no manager session until the user
   manually opens one. There's no first-class "this bot's manager".
4. **No live context seed.** Even the `ask` agent isn't seeded with the bot's
   manifest / status / recent logs up front, so it starts cold.

### Design
- **One Manager session per bot, auto-created on import** (`bots.ts` import flow):
  `mode:'ask'`, title `"<Bot> · Manager"`, `botId` set. Non-deletable like Main.
- **Capability tiers** (gate `allowWrites` instead of hard-false):
  - *Read* (default): logs, status, search, read files — always available to owner.
  - *Act* (restart/stop/start/git_pull/set_env/edit): unlocked when **owner +
    `autoApprove`** (the existing YOLO flag), else **per-action confirm modal**
    (reuse §2.5). Every action emits a `tool`/`tool_result` event the UI already renders.
- **Live system-prompt seed** per run: bot manifest, `get_status` snapshot,
  redacted env keys, last ~40 log lines → the manager never answers generically.
- **Own memory namespace:** key `agent/memory.ts` by `botId` so each manager
  accumulates its own history/notes.
- **UI:** bot card + detail → **"Open Manager"** (distinct from global Main chat);
  the Chat tab session drawer **groups sessions by bot** with the manager pinned top.
- **Optional — Telegram-reachable managers (L):** a per-bot Hermes *gateway*
  (parallels `telegram-hermes-bot`) so a manager is reachable from a DM, not just
  the Mini App. ⚠️ Heed the prior Hermes restart-loop lesson (kickstart `-k` +
  `resume_pending`) — see memory `hermes-gateway-restart-loop`. Only build if DM
  access is actually wanted; the in-app manager covers most needs.

### Effort
- Un-gate writes + confirm flow: **M.** Auto-manager + context seed: **M.**
- Group-by-bot drawer + "Open Manager": **S.** Telegram gateway: **L.**

---

## 8. Root cause — "the AI can't do anything" (the VPN screenshot)

The transcript ("I don't have external access / infrastructure access / diagnostic
tools") is a **Main `chat`-mode** response: that path is a plain LLM completion
with **no tools and no context**, so the model correctly says it can't do anything.
The capability exists — it's just on the *other* path (`ask`/agent).

**Fixes (in priority order):**
1. **Route bot questions to the manager** (§7) — the agent can literally
   `run_command`/`read_logs`/`get_status` to answer "are the VPN locations healthy?"
   for a given bot.
2. **Give Main an optional tool-enabled `fleet` scope** — a cross-bot agent
   (`scope:'fleet'`) that can list bots and answer fleet-wide questions, instead
   of a contextless chatbot. Keep a clearly-labelled "general chat (no tools)"
   only if we want a plain assistant too.
3. **Seed every agent run with live context** (§7) so answers are specific.
4. **Honest "not configured" state** — already handled (`AI not configured`), keep it.

---

## 9. Feature audit — "make every feature work"

### Verified bugs (root-caused)

| # | Feature | Symptom | Root cause | Fix | Effort |
|---|---|---|---|---|---|
| B1 | **Chat session rename** | Nothing happens on rename | `chat.ts` uses `window.prompt()` — **Telegram WebView blocks/no-ops `prompt`** | Replace with an in-app **prompt modal** (`App.prompt({title,value})`); backend `/api/chat/sessions/rename` already works | S |
| B2 | **Chat session delete** | Confirm never appears / no delete | `chat.ts` uses `window.confirm()` — also blocked in WebView | Reuse the §2.5 **confirm modal** | S |
| B3 | **AI gives generic answers** | "I can't access anything" | Main chat = no tools/context | §8 / §7 | M |
| B4 | **Manager can't act** | Agent reads but won't restart/fix | `allowWrites:false` hard-coded | §7 capability tiers | M |
| B5 | **Clear conversation** | No way to reset a session in UI | `/api/chat/sessions/reset` exists but isn't surfaced | Add "Clear conversation" to the session drawer/menu | S |
| B6 | **`updatesBehind` dead** | Always `null` | Never computed | §4.1 | S |

> **Pattern:** any reliance on `prompt()`/`confirm()`/`alert()` in the Mini App is
> a latent bug — Telegram's WebView disables them. Audit for these and route all
> through in-app modals. (Add `App.prompt` + `App.confirm` primitives to `shell.ts`
> once — fixes B1, B2, B5, and §2.5 together.)

### Full feature checklist (verify each end-to-end)

Run through every surface and confirm it works on a real phone in Telegram (not
just desktop browser, where `prompt`/`confirm` *do* work and hide B1/B2):

**Mini App**
- [ ] Fleet list loads, status dots correct, tap → detail
- [ ] Detail actions: Start / Stop / Restart / autostart toggle reflect real state
- [ ] Update / Push (git bots) — confirm flow + success toast
- [ ] Remove bot — confirm + disappears from fleet
- [ ] Logs load; Env load, edit, **Save** (secrets stay masked, blank = keep)
- [ ] Chat: send message streams tokens; tool activity shows for `ask`/manager
- [ ] Chat: **new session**, **rename** (B1), **delete** (B2), **switch**, **search**, **clear** (B5)
- [ ] Settings: toggles persist; Save; Test connection; Apply/rebuild confirm
- [ ] Access: list approved, approve by ID, revoke
- [ ] Non-owner: read-only (inputs disabled, Save hidden) + banner (§2.3)

**Bot (Telegram)**
- [ ] `/approve` ↔ Mini App access list parity (§3.6)
- [ ] Crash notification fires (§3.1) and isn't a restart-loop spam (memory: hermes-gateway-restart-loop)
- [ ] Control on/off matches `config.control.enabled`
- [ ] Per-bot manager reachable (if §7 Telegram gateway shipped)

---

_Last updated: 2026-06-24. Conventions: keep view JS free of backticks/`${}`
(string concat only — see `shell.ts` header); all new chrome must use the Raycast
design tokens in `shell.ts` (surface ladder, hairline borders, white CTA, Inter
+ ss03); accents (green/red/yellow/blue) are for status/illustration only.
**Mini App rule: never use `prompt`/`confirm`/`alert` — Telegram WebView blocks
them; use `App.prompt`/`App.confirm` modals.**_
