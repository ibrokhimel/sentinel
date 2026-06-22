import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from '@shared/types'
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
      backgroundAgent: parsed.backgroundAgent ?? DEFAULT.backgroundAgent
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
  writeStored(c)
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
  writeStored(c)
}

/** Remove a chat ID from the approved list and ignore future access requests. */
export function rejectUser(chatId: number): void {
  ignoreUser(chatId)
}
