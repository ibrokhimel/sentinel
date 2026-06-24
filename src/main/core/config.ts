import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig, UserProfile } from '@shared/types'
import { SENTINEL_HOME, ensureDirs } from './paths'

const CONFIG_PATH = join(SENTINEL_HOME, 'config.json')

interface StoredConfig {
  notify: {
    enabled: boolean
    chatId: string
    /** base64 — safeStorage ciphertext if encrypted, else plaintext (fallback). */
    token?: string
    tokenEncrypted?: boolean
  }
  /** Inbound Telegram control (reuses the notifier token + chatId). */
  control: { enabled: boolean }
  /** AI agent provider (OpenAI-compatible). Key encrypted like the notifier token. */
  agent: { baseUrl: string; model: string; key?: string; keyEncrypted?: boolean }
  /** GitHub token for pushing snapshots (e.g. to sentinel-live). Encrypted. */
  github?: { token?: string; tokenEncrypted?: boolean }
  /** Skip the agent's per-action approval prompts ("YOLO"/bypass mode). */
  autoApprove: boolean
  autoUpdateEnabled: boolean
  backgroundAgent: boolean
  /** Telegram chat IDs approved to use the bot. */
  approvedUsers?: number[]
  /** Telegram chat IDs awaiting an approval decision. */
  pendingUsers?: number[]
  /** Telegram chat IDs whose access requests are ignored. */
  ignoredUsers?: number[]
  /** Captured identity (name/@handle/timestamps) keyed by chat ID. */
  userProfiles?: Record<string, UserProfile>
  limits?: {
    maxBotsPerTenant: number
    aiPerDay: { chat: number; ask: number; fix: number }
  }
}

const DEFAULT: StoredConfig = {
  notify: { enabled: false, chatId: '' },
  control: { enabled: false },
  agent: { baseUrl: '', model: '' },
  autoApprove: false,
  autoUpdateEnabled: false,
  backgroundAgent: false
}

function readStored(): StoredConfig {
  if (!existsSync(CONFIG_PATH)) return structuredClone(DEFAULT)
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<StoredConfig>
    return {
      notify: { ...DEFAULT.notify, ...parsed.notify },
      control: { ...DEFAULT.control, ...parsed.control },
      agent: { ...DEFAULT.agent, ...parsed.agent },
      github: { ...parsed.github },
      autoApprove: parsed.autoApprove ?? DEFAULT.autoApprove,
      autoUpdateEnabled: parsed.autoUpdateEnabled ?? DEFAULT.autoUpdateEnabled,
      backgroundAgent: parsed.backgroundAgent ?? DEFAULT.backgroundAgent,
      // Access-control state — must be carried through, else every write after
      // an approval silently erases the approved/pending/ignored lists.
      approvedUsers: parsed.approvedUsers ?? [],
      pendingUsers: parsed.pendingUsers ?? [],
      ignoredUsers: parsed.ignoredUsers ?? [],
      userProfiles: parsed.userProfiles ?? {},
      limits: parsed.limits ?? {
        maxBotsPerTenant: 5,
        aiPerDay: { chat: 30, ask: 20, fix: 1 }
      }
    }
  } catch {
    return structuredClone(DEFAULT)
  }
}

function writeStored(c: StoredConfig): void {
  ensureDirs()
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}

/** Lazy-load Electron safeStorage (only available in the main process post-ready). */
function safeStorage(): typeof import('electron').safeStorage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron')
    return electron.safeStorage ?? null
  } catch {
    return null
  }
}

function encrypt(plain: string): { token: string; encrypted: boolean } {
  const ss = safeStorage()
  if (ss && ss.isEncryptionAvailable()) {
    return { token: ss.encryptString(plain).toString('base64'), encrypted: true }
  }
  // Fallback: store base64 plaintext (still chmod 600). Better than nothing.
  return { token: Buffer.from(plain, 'utf8').toString('base64'), encrypted: false }
}

function decrypt(token: string, encrypted: boolean): string {
  try {
    const buf = Buffer.from(token, 'base64')
    if (encrypted) {
      const ss = safeStorage()
      if (ss && ss.isEncryptionAvailable()) return ss.decryptString(buf)
      return ''
    }
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

/** Decrypted notifier config for internal use (token is plaintext). */
export function getNotifyConfig(): { enabled: boolean; token: string; chatId: string } {
  const c = readStored()
  const token = c.notify.token ? decrypt(c.notify.token, c.notify.tokenEncrypted ?? false) : ''
  return { enabled: c.notify.enabled, token, chatId: c.notify.chatId }
}

/** Sanitized config for the renderer (never includes the token). */
export function getAppConfig(): AppConfig {
  const c = readStored()
  return {
    notify: { enabled: c.notify.enabled, hasToken: !!c.notify.token, chatId: c.notify.chatId },
    control: { enabled: c.control.enabled, ready: !!c.notify.token && !!c.notify.chatId },
    agent: {
      baseUrl: c.agent.baseUrl,
      model: c.agent.model,
      hasKey: !!c.agent.key,
      ready: !!c.agent.baseUrl && !!c.agent.model && !!c.agent.key
    },
    autoApprove: c.autoApprove,
    autoUpdateEnabled: c.autoUpdateEnabled,
    backgroundAgent: c.backgroundAgent,
    hasGithubToken: !!c.github?.token
  }
}

/** Decrypted GitHub token (or '' if none) for git push operations. */
export function getGithubToken(): string {
  const c = readStored()
  return c.github?.token ? decrypt(c.github.token, c.github.tokenEncrypted ?? false) : ''
}

/** Store/clear the GitHub token. undefined keep · '' clear · else encrypt. */
export function setGithubToken(token: string | undefined): void {
  if (token == null) return
  const c = readStored()
  if (token === '') {
    c.github = {}
  } else {
    const { token: enc, encrypted } = encrypt(token)
    c.github = { token: enc, tokenEncrypted: encrypted }
  }
  writeStored(c)
}

export function getAutoApprove(): boolean {
  return readStored().autoApprove
}

export function setAutoApprove(on: boolean): void {
  const c = readStored()
  c.autoApprove = on
  writeStored(c)
}

/** Decrypted AI provider config for the agent runtime. */
export function getAgentConfig(): { baseUrl: string; model: string; apiKey: string; ready: boolean } {
  const c = readStored()
  const apiKey = c.agent.key ? decrypt(c.agent.key, c.agent.keyEncrypted ?? false) : ''
  return {
    baseUrl: c.agent.baseUrl,
    model: c.agent.model,
    apiKey,
    ready: !!c.agent.baseUrl && !!c.agent.model && !!apiKey
  }
}

/** Update AI provider settings. `key`: undefined keep · '' clear · else encrypt. */
export function setAgentConfig(patch: { baseUrl?: string; model?: string; key?: string }): void {
  const c = readStored()
  if (patch.baseUrl != null) c.agent.baseUrl = patch.baseUrl.trim()
  if (patch.model != null) c.agent.model = patch.model.trim()
  if (patch.key != null) {
    if (patch.key === '') {
      delete c.agent.key
      delete c.agent.keyEncrypted
    } else {
      const { token, encrypted } = encrypt(patch.key)
      c.agent.key = token
      c.agent.keyEncrypted = encrypted
    }
  }
  writeStored(c)
}

/**
 * Decrypted control config for the bot itself. Reuses the notifier token and
 * chat id — the owner who receives alerts is the owner who issues commands.
 */
export function getControlConfig(): { enabled: boolean; token: string; ownerChatId: string } {
  const c = readStored()
  const token = c.notify.token ? decrypt(c.notify.token, c.notify.tokenEncrypted ?? false) : ''
  return { enabled: c.control.enabled, token, ownerChatId: c.notify.chatId }
}

export function setControlEnabled(on: boolean): void {
  const c = readStored()
  c.control.enabled = on
  writeStored(c)
}

/**
 * Update notifier settings. `token` semantics:
 *   undefined → keep existing · '' → clear · non-empty → encrypt + store.
 */
export function setNotifyConfig(patch: { enabled?: boolean; chatId?: string; token?: string }): void {
  const c = readStored()
  if (patch.enabled != null) c.notify.enabled = patch.enabled
  if (patch.chatId != null) c.notify.chatId = patch.chatId
  if (patch.token != null) {
    if (patch.token === '') {
      delete c.notify.token
      delete c.notify.tokenEncrypted
    } else {
      const { token, encrypted } = encrypt(patch.token)
      c.notify.token = token
      c.notify.tokenEncrypted = encrypted
    }
  }
  writeStored(c)
}

export function setAutoUpdateEnabled(on: boolean): void {
  const c = readStored()
  c.autoUpdateEnabled = on
  writeStored(c)
}

export function setBackgroundAgentFlag(on: boolean): void {
  const c = readStored()
  c.backgroundAgent = on
  writeStored(c)
}

// ---- approved users (access control) --------------------------------------

/** List of Telegram chat IDs approved to use the bot. */
export function getApprovedUsers(): number[] {
  const c = readStored()
  return (c as any).approvedUsers ?? []
}

/** Check if a chat ID is in the approved users list. */
export function isUserApproved(chatId: number | string): boolean {
  return getApprovedUsers().includes(Number(chatId))
}

/** Add a chat ID to the approved users list. */
export function approveUser(chatId: number): void {
  const c = readStored()
  const list: number[] = (c as any).approvedUsers ?? []
  if (!list.includes(chatId)) list.push(chatId)
  ;(c as any).approvedUsers = list

  const ignored: number[] = (c as any).ignoredUsers ?? []
  const ignoredIdx = ignored.indexOf(chatId)
  if (ignoredIdx !== -1) {
    ignored.splice(ignoredIdx, 1)
    ;(c as any).ignoredUsers = ignored
  }

  // Clear from the pending queue and stamp the approval time on the profile.
  const pending: number[] = (c as any).pendingUsers ?? []
  const pIdx = pending.indexOf(chatId)
  if (pIdx !== -1) {
    pending.splice(pIdx, 1)
    ;(c as any).pendingUsers = pending
  }
  const profiles: Record<string, UserProfile> = (c as any).userProfiles ?? {}
  if (profiles[chatId]) profiles[chatId].approvedAt = Date.now()
  else profiles[chatId] = { id: chatId, approvedAt: Date.now() }
  ;(c as any).userProfiles = profiles
  writeStored(c)
}

// ---- user profiles + pending access queue --------------------------------

/** Read a known user's captured profile (names/handle), or a bare {id}. */
export function getUserProfile(chatId: number): UserProfile {
  const c = readStored()
  const profiles: Record<string, UserProfile> = (c as any).userProfiles ?? {}
  return profiles[chatId] ?? { id: chatId }
}

/** Upsert the identity fields we learn from a Telegram message. Only writes
 *  when something actually changed (keeps message handling cheap). */
export function recordUserProfile(p: {
  id: number
  firstName?: string
  lastName?: string
  username?: string
}): void {
  const c = readStored()
  const profiles: Record<string, UserProfile> = (c as any).userProfiles ?? {}
  const cur = profiles[p.id] ?? { id: p.id }
  const next: UserProfile = {
    ...cur,
    id: p.id,
    firstName: p.firstName ?? cur.firstName,
    lastName: p.lastName ?? cur.lastName,
    username: p.username ?? cur.username
  }
  if (JSON.stringify(next) === JSON.stringify(cur)) return
  profiles[p.id] = next
  ;(c as any).userProfiles = profiles
  writeStored(c)
}

/** Record a pending access request (captures identity, queues for approval).
 *  No-op if the user is already approved. */
export function addPendingRequest(p: {
  id: number
  firstName?: string
  lastName?: string
  username?: string
}): void {
  if (isUserApproved(p.id)) return
  recordUserProfile(p)
  const c = readStored()
  const pending: number[] = (c as any).pendingUsers ?? []
  if (!pending.includes(p.id)) pending.push(p.id)
  ;(c as any).pendingUsers = pending
  const profiles: Record<string, UserProfile> = (c as any).userProfiles ?? {}
  if (profiles[p.id] && profiles[p.id].requestedAt == null) {
    profiles[p.id].requestedAt = Date.now()
    ;(c as any).userProfiles = profiles
  }
  writeStored(c)
}

/** Profiles of everyone awaiting an approval decision. */
export function getPendingRequests(): UserProfile[] {
  const c = readStored()
  const pending: number[] = (c as any).pendingUsers ?? []
  const profiles: Record<string, UserProfile> = (c as any).userProfiles ?? {}
  return pending.map((id) => profiles[id] ?? { id })
}

/** Approved users as full profiles (names/handle), newest approvals first. */
export function getApprovedProfiles(): UserProfile[] {
  const profiles = (readStored() as any).userProfiles as Record<string, UserProfile> | undefined
  return getApprovedUsers()
    .map((id) => (profiles && profiles[id]) || { id })
    .sort((a, b) => (b.approvedAt ?? 0) - (a.approvedAt ?? 0))
}

/** List of Telegram chat IDs whose access requests should be ignored. */
export function getIgnoredUsers(): number[] {
  const c = readStored()
  return (c as any).ignoredUsers ?? []
}

/** Check if a chat ID is in the ignored users list. */
export function isUserIgnored(chatId: number | string): boolean {
  return getIgnoredUsers().includes(Number(chatId))
}

/** Add a chat ID to the ignored users list and remove it from approvals. */
export function ignoreUser(chatId: number): void {
  const c = readStored()
  const ignored: number[] = (c as any).ignoredUsers ?? []
  if (!ignored.includes(chatId)) ignored.push(chatId)
  ;(c as any).ignoredUsers = ignored

  const approved: number[] = (c as any).approvedUsers ?? []
  const idx = approved.indexOf(chatId)
  if (idx !== -1) {
    approved.splice(idx, 1)
    ;(c as any).approvedUsers = approved
  }

  const pending: number[] = (c as any).pendingUsers ?? []
  const pIdx = pending.indexOf(chatId)
  if (pIdx !== -1) {
    pending.splice(pIdx, 1)
    ;(c as any).pendingUsers = pending
  }
  writeStored(c)
}

/** Remove a chat ID from the approved list and ignore future access requests. */
export function rejectUser(chatId: number): void {
  ignoreUser(chatId)
}

// ---- tenancy: host identity & per-tenant limits ---------------------------

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
