# Sentinel Multi-Tenant Collaboration (Phase 2) — Design

**Date:** 2026-06-25
**Status:** Approved (design), pending spec review → implementation plan
**Builds on:** Phase 1 isolation (`docs/superpowers/specs/2026-06-24-multi-tenant-isolation-design.md`), merged to main.

---

## 1. Problem & Context

Phase 1 gave each approved tenant an isolated workspace (own bots only). The data model (`collaborators: Record<uid, Capabilities>` on each registry entry) and the authorization chokepoint (`authz.ts can()` — which already honors collaborator capability toggles) shipped in Phase 1 and are tested. But **nothing can populate the collaborators map** — there is no API, no UI, so collaboration is inert.

Phase 2 makes it usable: a bot **owner** can add another approved tenant as a **collaborator** on one of their bots and grant granular, per-collaborator capabilities (the "Telegram admin rights" toggle model). Collaboration is a **Mini App** feature; the Telegram control bot is intentionally narrowed to owned-only bots this phase.

---

## 2. Capability Model (mostly already built)

`Capabilities` (registry.ts) and `Capability` (authz.ts) already define the six toggles. Phase 2 uses them as-is:

| Toggle | Grants (on that bot) |
|---|---|
| `viewLogs` | read the bot's logs |
| `chat` | use AI `ask` on the bot |
| `startStop` | start / stop / restart |
| `deploy` | update / redeploy (git pull) |
| `editEnv` | open the env editor; set/overwrite values (incl. secrets, write-only) |
| `viewSecrets` | **reveal** secret env values in plaintext (see §4) |

- Being a collaborator at all = implicit `view` (see status/stats, appear in the bot list).
- Owner and host implicitly have all capabilities (via `can()` rules 1–2). This means owner/host also gain plaintext secret reveal — a deliberate new capability (today no one can read plaintext; see §8 Risks).
- Managing collaborators and **removing the bot** are never delegable — owner/host only (no capability grants them).

---

## 3. Data Model & Registry Helpers (registry.ts)

`RegistryEntry.collaborators?: Record<string, Capabilities>` already exists. Add helpers:

```ts
// Add or replace a collaborator's capability set on a bot.
export function setCollaborator(botId: string, uid: number, caps: Capabilities): void
// Remove a collaborator from a bot.
export function removeCollaborator(botId: string, uid: number): void
```

Both read-modify-write the registry (mirroring `setBotOwner`). `setCollaborator` writes `entry.collaborators[String(uid)] = caps` (normalizing to only the six known boolean keys; unknown keys dropped). `removeCollaborator` deletes the key (and the `collaborators` object if it becomes empty). No-op if the bot does not exist.

---

## 4. Secret Reveal (state.ts `getEnv`)

Today `getEnv` masks every secret key (returns `''` for keys matching `SECRET_KEY_RE`) for everyone. Phase 2: return the real value **only** when the requester has `viewSecrets` on that bot.

```ts
const reveal = can(c.auth.userId, c.auth.isOwner, findEntry(id), 'viewSecrets')
// for a secret key: current[k] = reveal ? (env.current[k] ?? '') : ''
```

`getEnv` is already gated by `assertCap(..., 'editEnv')` (Phase 1), so only owner/host or an `editEnv` collaborator can call it at all; `viewSecrets` further controls whether the *values* come back unmasked. The response keeps `secretKeys`/`hasValue` so the UI can show a reveal affordance. A collaborator with `editEnv` but not `viewSecrets` sees masked values (and can still overwrite — write-only, unchanged).

**Security note:** when `viewSecrets` is set, plaintext secrets travel over the cloudflared tunnel (TLS) to the client. This is new exposure (see §8).

---

## 5. API — Collaborator Management (new route module `routes/collaborators.ts`)

All three are authorized as **owner-of-that-bot-or-host** (not a delegable capability). Each handler resolves the entry and checks `c.auth.isOwner || entry.ownerId === c.auth.userId`; otherwise 403. Registered in `routes/index.ts` `ROUTES`.

- `GET /api/bots/collaborators?botId=…` → `{ collaborators: Array<{ id, firstName?, lastName?, username?, caps: Capabilities }>, addable: UserProfile[] }`
  - `collaborators`: current map joined with `userProfiles` for display.
  - `addable`: `getApprovedProfiles()` minus the host uid, minus the bot's `ownerId`, minus uids already collaborators — the picker source.
- `POST /api/bots/collaborators` `{ botId, userId, capabilities }` → validate `userId` is a finite number and an approved tenant (in `getApprovedUsers()`); coerce `capabilities` to the six known booleans; `setCollaborator`; return the refreshed snapshot.
- `POST /api/bots/collaborators/remove` `{ botId, userId }` → `removeCollaborator`; return the refreshed snapshot.

`routes/index.ts` `Route.ownerOnly` is **not** used for these (a non-host bot owner must reach them) — they set `ownerOnly: false` and enforce ownership inside, consistent with Phase 1's bots/state routes. Invalid `botId`/`userId` → 400; not-owner/host → 403.

---

## 6. UI — Collaborators card on Bot Detail (frontend)

Add an owner-only **Collaborators** section to the bot-detail UI, which is rendered in `src/main/core/miniapp/frontend/views/fleet.ts` (the view that calls `/api/env`, `/api/action`, `/api/logs`). Embedded-JS strings; **no backticks/`${}`**, matching surrounding style:
- Renders only when the viewer owns the bot or is host (`st.owner` / ownership signal already available to the detail view).
- Lists current collaborators (name/@handle) each with a row of six toggle switches reflecting their caps; flipping a switch calls `POST /api/bots/collaborators` with the updated set.
- An "Add collaborator" control: a picker populated from the `addable` list; selecting one adds them with all toggles off (owner then flips on what they want).
- A remove (x) per collaborator → `POST /api/bots/collaborators/remove`.
- The env editor gains a per-secret "reveal" affordance shown only when the API returned an unmasked value (i.e., the viewer has `viewSecrets`).

---

## 7. Control Bot → owned-only this phase (telegramBot.ts)

The control bot's per-bot **text** commands gate on visibility, not per-capability. To avoid a view-only collaborator exceeding their toggles via Telegram, narrow the control bot to **owned bots only** for Phase 2: replace its `botsVisibleTo`-based `visibleBots(chatId,isOwner)` with an owned-or-host filter (`entry.ownerId === chatId || isOwner`). Collaborators manage shared bots through the Mini App (which is already per-capability correct). Full per-capability gating of the control bot is deferred to a later phase. This is a one-helper change; everything else in telegramBot.ts stays.

---

## 8. Enforcement already correct (no change needed)

Phase 1 already gates the Mini App per-bot routes via `assertCap`: `logs→viewLogs`, `env→editEnv`, `action→startStop`, metrics→`view`, chat `ask`→visibility + `editEnv` write-gate. The moment `collaborators` is populated, a collaborator using the dashboard is correctly limited. Phase 2 adds only the `viewSecrets` reveal branch (§4); the rest of enforcement is unchanged.

---

## 9. Testing Strategy

- **registry helpers:** `setCollaborator` adds/updates/normalizes (drops unknown keys); `removeCollaborator` deletes and prunes empty map; both no-op on unknown bot; idempotent.
- **collaborators routes:** owner can add/update/remove; a non-owner non-host tenant gets 403; adding a non-approved uid → 400; `addable` excludes host/owner/existing; snapshot shape correct.
- **secret reveal:** `getEnv` returns plaintext for a `viewSecrets` collaborator (and owner/host) and masked for an `editEnv`-only collaborator; non-secret values unaffected.
- **capability enforcement end-to-end:** with a real collaborator entry, `/api/logs` allowed for `viewLogs` collaborator and denied (403) for one without it; `/api/action` denied without `startStop`; `/api/env` POST denied without `editEnv`.
- **control bot owned-only:** `visibleBots`/filter returns only owned bots for a user who is a collaborator (not owner) on another bot; host still sees all.
- All Phase 1 tests stay green. Do not modify the dirty files (`integration.launchd.test.ts`, `launchctl.ts`, `monitor.ts`).

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Plaintext secret reveal over the tunnel** (new exposure) | Gated by an explicit, off-by-default `viewSecrets` toggle the owner must deliberately grant; values still only reach an authenticated, capability-checked requester over TLS. Documented as an owner-chosen tradeoff. |
| Owner grants a capability to the wrong person | Picker is limited to already-approved tenants shown by name/@handle; all toggles start off; owner can change/remove anytime. |
| A collaborator escalating via the control bot | Control bot narrowed to owned-only this phase (§7); collaboration is Mini-App-only where per-capability gating already holds. |
| Capability map drift / unknown keys persisted | `setCollaborator` normalizes to the six known boolean keys only. |
| Removing the bot owner via collaborators API | Owner/host-only on all three endpoints; remove-bot remains owner/host-only (no capability grants it). |

---

## 11. Out of Scope (YAGNI / later phases)

Invite links / per-bot collaboration links; collaborating with non-tenants; full per-capability gating of the Telegram control bot (owned-only suffices this phase); transferring bot ownership; AI metering (Phase 3); workspace entity, OS sandboxing, billing.

---

## 12. File Touch List

- `src/main/core/registry.ts` — `setCollaborator`, `removeCollaborator`.
- `src/main/core/miniapp/routes/collaborators.ts` — new route module (3 endpoints).
- `src/main/core/miniapp/routes/index.ts` — register `collaboratorRoutes`.
- `src/main/core/miniapp/routes/state.ts` — `getEnv` `viewSecrets` reveal branch.
- `src/main/core/miniapp/frontend/views/fleet.ts` — Collaborators card + reveal affordance (this view renders bot detail).
- `src/main/core/telegramBot.ts` — `visibleBots` → owned-only filter.
- Tests under `src/main/core/__tests__/` for each.
