# Sentinel Multi-Tenant Isolation — Design

**Date:** 2026-06-24
**Status:** Approved (design), pending spec review → implementation plan
**Scope of this doc:** Full multi-tenant model documented; **Phase 1 (Isolation)** is the implementable slice this spec commits to. Phases 2–3 are described for context and will get their own spec/plan cycles.

---

## 1. Problem & Reframe

Today Sentinel is **single-tenant**: one owner (`control.ownerChatId`) sees and controls every bot; a small `approvedUsers` allowlist lets a few others into the *same shared* dashboard. The user wants the opposite: **every approved person gets their own isolated workspace** — their own bots and dashboard — and can do almost everything the owner can *within their own workspace*, but cannot see anyone else's bots unless explicitly invited as a collaborator.

Critically: **BotFather has no "approved users" allowlist.** Telegram verifies *who* a user is (Mini App `initData` HMAC; bot message `from.id`) but never decides allow/deny for a bot's DMs. All access control must live in Sentinel. We therefore do **not** delete access control — we **invert** it: "approved" stops meaning "can see the owner's bots" and starts meaning "is a tenant with their own workspace." Every screen and API filters by *what you own or were invited to*.

**Trust model (decided):** invite-only, semi-trusted friends on a single Mac. Isolation is at the **data/dashboard layer, not the OS layer** — a tenant can run bot code as launchd processes under the host's macOS user. Acceptable for trusted friends; guarded by per-tenant quotas. Stranger-proofing (containers/cloud) is explicitly out of scope.

---

## 2. Roles & Identity

| Role | Identity source | Powers |
|------|-----------------|--------|
| **Host (super-admin)** | `control.ownerChatId` (existing) — same value `service.ts` already uses for `isOwner` | Sees & controls **all** bots and all tenants. Owns all global/runtime settings. Manages the access queue. |
| **Tenant** | A uid in `approvedUsers` | Owns the bots they create; sees only owned + collaborated bots. Subset of settings. |
| **Collaborator** | A uid present in a specific bot's `collaborators` map | Per-bot capabilities, granularly toggled by that bot's owner. |

Identity is already verified and surfaced as `RouteCtx.auth = { userId, isOwner }` (`miniapp/service.ts:173 authorize()`). No new auth mechanism is introduced; we add **authorization** (what you may do) on top of the existing **authentication** (who you are).

---

## 3. Data Model Changes

### 3.1 Bot ownership (`registry.ts`)
Extend `RegistryEntry`:

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
  dirName: string
  ownerId?: number                               // NEW — Telegram uid of owner
  collaborators?: Record<string, Capabilities>   // NEW — uid → toggles
}
```

`ownerId`/`collaborators` are optional so existing `registry.json` parses unchanged.

### 3.2 Migration
On first load after upgrade, any `RegistryEntry` with no `ownerId` is stamped `ownerId = host uid` (parsed from `control.ownerChatId`) and `collaborators = {}`. Implemented as a one-pass normalization inside `readRegistry()` (write-back only if something changed, mirroring `config.ts recordUserProfile`'s "only write on change" pattern). **Result: all your current bots remain yours; nothing moves.**

### 3.3 Tenancy & quotas (`config.ts`)
- `approvedUsers` (existing, just fixed) = the tenant set.
- New host-tunable config (defaults chosen by us, host can change):
  - `limits.maxBotsPerTenant` (default **5**; host unlimited)
  - `limits.aiPerDay` (default e.g. `{ chat: 30, ask: 20, fix: 1 }`; host unlimited) — **defined now, enforced in Phase 3**
- Per-tenant AI counter store (`aiUsage: Record<uid, { date, chat, ask, fix }>`) is a **Phase 3** addition; Phase 1 does not build it.

All new config fields must be **carried through `readStored()`** — this is the exact bug class we just fixed (whitelist drop). The spec's plan will include a regression test asserting round-trip persistence of every new field.

---

## 4. Authorization Chokepoint (`miniapp/authz.ts` — NEW)

A single module is the security-critical core. Everything bot-scoped routes through it.

```ts
type Capability = 'view' | 'viewLogs' | 'chat' | 'startStop' | 'deploy' | 'editEnv' | 'viewSecrets'

// Pure decision function — no I/O beyond reading the registry entry passed in.
function can(uid: number, isHost: boolean, entry: RegistryEntry, cap: Capability): boolean
```

Rules (in order):
1. `isHost` → allow everything.
2. `uid === entry.ownerId` → allow everything.
3. `uid` in `entry.collaborators` → `cap === 'view'` always true; otherwise the matching toggle.
4. else → deny.

Helpers built on `can`:
- `botsVisibleTo(uid, isHost)` → filter `readRegistry()` to entries where `can(...,'view')`.
- `assertCap(ctx, botId, cap)` → resolves entry, throws a typed `ForbiddenError` (→ 403) if denied. Used at the top of every bot-scoped route handler.

This module is **pure and table-tested** (no network/fs in the decision path), so we can exhaustively cover the matrix: host × owner × collaborator(each toggle) × stranger × unknown-bot.

---

## 5. Enforcement Points (where Phase 1 wires it in)

| Surface | File | Change |
|---|---|---|
| Bot list / fleet | `miniapp/routes/state.ts`, `metrics.ts` | Return only `botsVisibleTo(auth.userId, auth.isOwner)`. Summary stats scoped to that set. |
| Bot import/deploy | `miniapp/routes/bots.ts` | On import, stamp `ownerId = auth.userId`. Enforce `maxBotsPerTenant` (count owned bots). Drop blanket `ownerOnly` → allow any tenant, scoped to self. |
| Bot remove | `miniapp/routes/bots.ts` | Owner/host only (no collaborator capability grants remove) — enforced by requiring rule 1 or 2 in `can()`; collaborators always denied. |
| Chat / ask / fix | `miniapp/routes/chat.ts`, `sessions.ts` | Sessions namespaced per uid (`sessions` store keyed by `uid`); `chat`/fleet scope limited to caller's visible bots; `ask` requires `chat` cap on the target bot. |
| Control bot | `telegramBot.ts` | `sup.listBots()` results filtered to the message sender's visible bots; per-action callbacks (`start/stop/restart/update/remove/env/logs/ask/fix`) gated through `can(...)`. Host keeps full fleet. |
| Settings | `miniapp/routes/state.ts` + `frontend/views/settings.ts` | Host-only sections gated by `auth.isOwner`; tenants get a slimmed, self-scoped view. |
| Access queue | `miniapp/routes/users.ts` | Already `ownerOnly` — unchanged. Approve = onboard tenant (no longer = "see my bots", which ownership filtering now enforces independently). |

**Secrets:** the existing `maskSecret()` (`telegramBot.ts:193`) already returns only length; env *values* are never sent raw. Phase 1 keeps masking universal. Phase 2 adds a `viewSecrets`-gated reveal. So Phase 1 has no secret-exposure regression risk.

---

## 6. Settings Split

- **Host-only (gated by `auth.isOwner`):** notifier token & chatId, control toggle, auto-update, maintenance/rebuild, tunnel, **shared AI provider key**, access queue, global save, per-tenant limits.
- **Tenant view:** own profile, AI quota remaining (Phase 3), (Phase 3) optional own AI key. Tenants never receive host-section data from the API — enforcement is server-side in `state.ts`, not just hidden in the frontend.

---

## 7. Onboarding (repurposed queue)

`/start` from an unknown uid → `addPendingRequest` (the now-fixed flow) → host taps **Approve** → `approveUser(uid)` makes them a tenant. Their Mini App opens to an **empty "My Bots"** dashboard with the existing empty-state CTA. They own nothing yet, so ownership filtering shows them nothing of yours. No queue-UI changes needed; only the *meaning* of approval changes, which is already true once filtering lands.

---

## 8. AI Metering (Phase 3 — described, not built in Phase 1)

Shared host key (`getAgentConfig()`), wrapped by a per-uid daily counter checked before each agent run; host and host-owned bots are unlimited. On exceed → friendly toast ("daily AI limit reached"). Optional per-tenant own-key override lifts the cap. Phase 1 leaves agent calls unmetered (host + trusted friends), only ensuring sessions are uid-scoped so metering has a clean seam later.

---

## 9. Phasing

- **Phase 1 — Isolation (THIS spec → first plan):** §3 model + migration, §4 `authz.ts`, §5 enforcement (visibility filtering everywhere + ownership stamping + bot quota), §6 settings split, §7 onboarding meaning. Outcome: you + friends each get isolated dashboards; you stay god-mode; each person sees only their own bots. No collaboration UI yet.
- **Phase 2 — Collaboration:** invite a uid onto a bot, the Telegram-admin-rights-style capability toggle UI, `viewSecrets`-gated secret reveal, collaborator CRUD routes.
- **Phase 3 — AI metering:** per-tenant daily caps + usage view + optional own key.

---

## 10. Testing Strategy

- **`authz.test.ts`** — exhaustive truth table for `can()` across host/owner/each-collaborator-toggle/stranger/unknown-bot. This is the security spine; must be comprehensive.
- **Registry migration test** — old `registry.json` (no `ownerId`) → entries stamped to host; idempotent; no rewrite when already stamped.
- **Config round-trip test** — every new config field survives `readStored()`→`writeStored()` (guards against the whitelist-drop bug class).
- **Route filtering tests** — a tenant requesting state/metrics/bots sees only owned bots; a tenant cannot remove/act on a non-owned bot (403); host sees all.
- **Quota test** — tenant blocked at `maxBotsPerTenant`; host unaffected.
- All existing tests must stay green; no changes to the dirty files called out by the workspace (`integration.launchd.test.ts`, `launchctl.ts`, `monitor.ts`).

---

## 11. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| OS-level isolation absent (tenant code runs on host Mac) | Invite-only trusted friends; per-tenant bot quota; documented limitation. Containers = out of scope. |
| New config fields silently dropped (the bug we just fixed) | Carry-through in `readStored()` + explicit round-trip test. |
| A missed enforcement point leaks another tenant's bot | Single `authz` chokepoint + filtering tests per route; default-deny in `can()`. |
| Frontend hides host settings but API still returns them | Enforce server-side in `state.ts`; treat frontend gating as cosmetic only. |
| Migration mis-assigns ownership | Default unowned → host (you); idempotent; covered by test. |

---

## 12. Out of Scope (YAGNI)

Separate "workspace" entity (workspace = implicitly your owned+collaborated bots), OS/container sandboxing, public self-signup, billing, multi-host federation, per-tenant tunnels/subdomains.
