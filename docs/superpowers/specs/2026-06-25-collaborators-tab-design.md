# Collaborators ("Team") Navbar Tab — Design

**Date:** 2026-06-25
**Status:** Approved (design), pending spec review → implementation plan
**Builds on:** Phase 2 collaboration (merged to main). Phase 2 put collaborator management in a card inside each bot's detail screen; this adds a dedicated top-level **Team** tab as the hub.

---

## 1. Problem

Collaboration management today lives only as a card inside one bot's detail view — you must drill into each bot to see/manage who it's shared with, and there is no place to see bots that have been shared *with you*. Add a dedicated **Team** navbar tab that surfaces both directions in one screen.

---

## 2. Scope

- A new navbar tab labeled **Team**, visible to every authenticated user (owner sees what they share; collaborator sees what's shared with them).
- A new read endpoint that returns, for the caller: bots they own (with collaborators + the addable-tenant picker) and bots shared with them (with their capabilities).
- All *mutations* reuse the existing Phase-2 endpoints (`POST /api/bots/collaborators`, `/api/bots/collaborators/remove`) — no new write surface, no new authorization.
- The existing per-bot Collaborators card stays (contextual quick access); the tab is the hub.

---

## 3. Backend — `GET /api/collaborations` (new, in `routes/collaborators.ts`)

`ownerOnly: false` (any authenticated tenant). Returns:

```ts
{
  owned: Array<{
    id: string
    name: string
    collaborators: Array<UserProfile & { caps: Capabilities }>
    addable: UserProfile[]
  }>,
  shared: Array<{
    id: string
    name: string
    owner: UserProfile            // bot owner's profile (name/@handle)
    caps: Capabilities            // the caller's capabilities on this bot
  }>
}
```

Logic (reads only what `can()`/ownership already authorize):
- **owned**: `readRegistry()` filtered to `e.ownerId === c.auth.userId` (host → all entries). For each, build `collaborators` (join `collaborators` map with `getUserProfile`) and `addable` (`getApprovedProfiles()` minus host, minus owner, minus existing) — reusing the existing `snapshot()` helper logic in `collaborators.ts`.
- **shared**: `readRegistry()` where `e.collaborators?.[String(uid)]` exists AND `e.ownerId !== uid` → `{ id, name, owner: getUserProfile(e.ownerId), caps: e.collaborators[String(uid)] }`.
- Registered in `routes/index.ts` (already spreads `collaboratorRoutes`).

No secret values are returned (only profiles + capability booleans), consistent with the existing collaborators endpoints.

---

## 4. Frontend — new view `views/collaborators.ts` + navbar registration

- The module exports `collaboratorsView: { js: string }` and self-registers at the end of its JS via `App.registerView('team', { label: 'Team', icon: App.icon(<people/team icon>), render })` — exactly like `fleetView`/`settingsView`/`botsManageView` do. Visible to all (no `owner:true`). It is wired into the navbar by adding `collaboratorsView` to the `assemble([...])` array in `frontend/index.ts` (which imports each `*View` and concatenates their JS into `MINIAPP_HTML`); the navbar is built from registered views in that order.
- `render(root, st)`:
  - On enter, `App.api('/api/collaborations')` → render two sections.
  - **Bots you share** (`owned`): for each bot, a card with the bot name + collaborator rows (display name + the six capability checkboxes reflecting `caps` + a remove button) + an "Add collaborator" `<select>` from `addable` + Add button. Toggle change → `POST /api/bots/collaborators` with the full six-key object; add → POST all-false; remove → `POST /api/bots/collaborators/remove`. After any mutation, re-fetch and re-render. If a bot has no collaborators, show a muted hint; if `addable` is empty, "No more tenants to add."
  - **Shared with you** (`shared`): read-only rows — bot name · "shared by <owner>" · the caps you have (as small labels). No controls.
  - Empty state when both lists are empty: a friendly "No shared bots yet. Open a bot and add a collaborator, or ask an owner to share one with you."
- Embedded-JS string style: single-quoted concatenation, **no backticks/`${}`**, matching the existing views. Reuses the same `App.api`/`App.esc`/`App.icon`/`App.toast` helpers and the six-capability list/labels already used by the per-bot card.

---

## 5. Testing

- **Endpoint**: a user who owns bot A (with a collaborator) and collaborates on bot B gets `owned:[A with its collaborators+addable]` and `shared:[B with caps]`; a user with neither gets `{owned:[],shared:[]}`; host gets all bots under `owned`. `addable` excludes host/owner/existing. No secret values present.
- **Frontend**: covered by `npm run build` (compiles embedded JS — catches backtick/syntax slips) + manual smoke; the mutation paths reuse already-tested endpoints.
- All existing tests stay green. Do not modify the dirty files (`integration.launchd.test.ts`, `launchctl.ts`, `monitor.ts`).

---

## 6. Out of Scope

People-centric grouping (by collaborator instead of by bot); inviting non-tenants; bulk operations; changing the existing per-bot card; any backend authorization change (mutations reuse the existing owner/host-only routes).

---

## 7. File Touch List

- `src/main/core/miniapp/routes/collaborators.ts` — add `GET /api/collaborations` + a `collaborations(uid, isHost)` helper (reuse `snapshot` pieces).
- `src/main/core/miniapp/frontend/views/collaborators.ts` — new view module exporting `collaboratorsView` (the Team tab; self-registers via `App.registerView('team', …)`).
- `src/main/core/miniapp/frontend/index.ts` — import `collaboratorsView` and add it to the `assemble([...])` array so it loads into `MINIAPP_HTML` and appears in the navbar.
- Tests under `src/main/core/__tests__/`.
