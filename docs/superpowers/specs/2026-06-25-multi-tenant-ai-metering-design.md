# Sentinel Multi-Tenant AI Metering (Phase 3) — Design

**Date:** 2026-06-25
**Status:** Approved (design), pending spec review → implementation plan
**Builds on:** Phase 1 isolation + Phase 2 collaboration. `limits.aiPerDay` already exists in `config.ts` but is **not enforced**.

---

## 1. Problem

AI features (`chat` / `ask` / `fix`) run against the **host's single shared provider key**. With Phase 2 collaboration shipped, multiple tenants can now invoke AI, all spending the host's tokens/money, with **no cap enforced**. Phase 3 enforces per-tenant daily limits on the shared key so a friend cannot run up unbounded spend.

Decided scope: **caps only** (no per-tenant "bring your own key" escape hatch — that is a future phase).

---

## 2. Metering Model

- Metered per **acting user** (the authenticated requester), per **action kind** (`chat`, `ask`, `fix`), per **calendar day** (host machine local date).
- The **host is unlimited and never counted** (`getHostUid()` match). **Every other authenticated user is metered** — whether they own the bot or collaborate on it. A collaborator's `ask` counts against *their own* quota.
- **Reachability note (informs which caps bite):** fleet/`chat` mode is host-only (Phase 1), so for non-host users only `ask` (Mini App per-bot + control-bot `/ask`) and `fix` (control-bot `/fix`) are reachable. The `chat` counter remains defined for completeness but in practice only the (unlimited) host reaches it.
- Counting is **per allowed initiation** of an AI run, not per token. No refund on a run that errors *after* it started; but see §4 ordering so a not-configured provider never consumes quota.

---

## 3. Storage & Limits (`config.ts`)

Add to `StoredConfig` (and carry through `readStored()` — the whitelist there silently drops unlisted keys; this is the recurring bug class):

```ts
aiUsage?: Record<string, { date: string; chat: number; ask: number; fix: number }>
```

- Keyed by `String(uid)`. `date` is `YYYY-MM-DD` in host local time.
- Limits come from the existing `getLimits().aiPerDay` (`{ chat, ask, fix }`), defaulted in Phase 1 to **chat 30 / ask 20 / fix 1**, host-tunable via the existing `setLimits`. No new limit plumbing.

---

## 4. Enforcement Helper (`config.ts`)

A single function is the metering chokepoint:

```ts
type AiKind = 'chat' | 'ask' | 'fix'
// Host → always { ok: true, remaining: Infinity }, no count.
// Else: roll the day if stale, then if count >= limit → { ok:false, remaining:0 };
//       otherwise increment + persist → { ok:true, remaining: limit-count }.
export function checkAndCountAi(uid: number, isHost: boolean, kind: AiKind): { ok: boolean; remaining: number }
// Read-only view for display (no mutation, rolls a stale day to zeros in the returned value only).
export function getAiUsage(uid: number, isHost: boolean): { used: Record<AiKind, number>; limits: { chat: number; ask: number; fix: number }; unlimited: boolean }
```

`checkAndCountAi` does a read-modify-write of `aiUsage[uid]`: if `aiUsage[uid].date !== today` (or absent) it resets that user's three counts to 0 and sets `date = today` before checking. Host short-circuits before any read/write.

**Call-site ordering at every AI entry point:** (1) verify the provider is ready / inputs valid; (2) `checkAndCountAi`; (3) if `!ok` send the friendly limit message and stop; (4) run the agent. This guarantees an unconfigured-provider or empty-message error never burns quota.

---

## 5. Enforcement Points

| Surface | File | Change |
|---|---|---|
| Mini App stream | `miniapp/routes/chat.ts` | After the existing provider-ready/empty-message checks, before `runAgent`: `kind = sess.mode === 'ask' ? 'ask' : 'chat'`; `checkAndCountAi(c.auth.userId, c.auth.isOwner, kind)`; on `!ok` send SSE `{ type:'error', message:'Daily AI limit reached — resets tomorrow.' }` and `res.end()`. |
| Control bot `/ask` `/fix` | `telegramBot.ts` `runAgentSession` | Compute `isOwner` (already does), resolve the bot (already filtered owned-only); after provider-ready, `checkAndCountAi(chatId, isOwner, fix ? 'fix' : 'ask')`; on `!ok` send a Telegram "daily AI limit reached" message and return (do not run). |
| Control bot buttons | `telegramBot.ts` `startAgentForBot` | host-only path; still call `checkAndCountAi(chatId, isOwner, ...)` for consistency — no-op for host. (Optional; safe.) |
| Fleet chat (`/ai`, bare text) | `telegramBot.ts` | host-only already; the host is unlimited, so no enforcement needed there. |

`runChat` (host fleet chat) is host-only and unlimited — no metering call required, but adding one is harmless (host short-circuits).

---

## 6. Visibility (light)

- `GET /api/state` includes the requester's own quota: `ai: getAiUsage(c.auth.userId, c.auth.isOwner)` → `{ used:{chat,ask,fix}, limits:{...}, unlimited:boolean }`.
- The Mini App shows a small line for non-host users (e.g. in the tenant settings view or near chat): "AI today — ask 3/20 · fix 0/1". Host sees "unlimited" or nothing. Embedded-JS string style, no backticks/`${}`.
- No separate dashboard, history, or charts.

---

## 7. Testing Strategy

- `checkAndCountAi`: increments per kind; independent counters; host returns ok+unlimited and never writes `aiUsage`; blocks at limit (`count >= limit` → ok:false); rolls to fresh zeros when stored `date` differs from today (inject "today" via a small seam or by manipulating the stored date in the in-memory fs mock).
- Round-trip: `aiUsage` survives `readStored()`→`writeStored()` (guards the drop-bug).
- `getAiUsage`: returns correct used/limits; `unlimited:true` for host; reflects a stale-day reset as zeros without mutating.
- chat.ts: a tenant at the `ask` limit gets the SSE limit error and `runAgent` is NOT called; provider-not-ready returns the config error WITHOUT counting.
- telegramBot.ts: `runAgentSession` refuses `/fix` for a tenant at the fix limit (count not exceeded → runs; at limit → limit message, agent not started); host unaffected.
- All Phase 1/2 tests stay green. Do not modify the dirty files (`integration.launchd.test.ts`, `launchctl.ts`, `monitor.ts`).

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Read-modify-write race on the JSON store under concurrent AI calls could under-count | Acceptable for a soft cap on a single-user host; calls are low-frequency and the worst case is a tenant getting one extra run. |
| Date uses host local time, so "day" boundary is the host's midnight | Intended; matches the owner's mental model. Documented. |
| Counting an action that the provider later rejects mid-run | Acceptable for a simple action cap; the §4 ordering already prevents counting the common pre-flight failures (not-configured, empty message). |
| New `aiUsage` field silently dropped by `readStored()` | Explicit carry-through + a round-trip test (same guard used for `limits`, `approvedUsers`, etc.). |

---

## 9. Out of Scope (YAGNI / later)

Per-tenant own-key override; token-based (vs action-based) metering; monthly or rolling-window limits; usage history/analytics; per-bot (vs per-user) quotas; alerting the host when a tenant hits a limit.

---

## 10. File Touch List

- `src/main/core/config.ts` — `aiUsage` field + carry-through; `checkAndCountAi`; `getAiUsage`.
- `src/main/core/miniapp/routes/chat.ts` — meter the stream (ask/chat).
- `src/main/core/telegramBot.ts` — meter `runAgentSession` (`/ask`,`/fix`) and `startAgentForBot`.
- `src/main/core/miniapp/routes/state.ts` — add `ai` quota to the `/api/state` payload.
- `src/main/core/miniapp/frontend/views/settings.ts` (or fleet/chat view) — small quota line for non-host users.
- Tests under `src/main/core/__tests__/`.
