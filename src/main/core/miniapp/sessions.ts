/**
 * Persistent multi-session chat store for the Mini App. One JSON file holds
 * every session: the non-deletable Main chat (free-form streaming) plus any
 * number of per-bot "ask" sessions. Caps keep the file (and the context we
 * replay into the model) bounded.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DATA_HOME } from '../paths'

/**
 * Where session state lives. SENTINEL_DATA_HOME overrides the default (used by
 * tests so they never touch the real ~/Library/Application Support/Sentinel).
 * Resolved lazily on each call so an env change between operations is honored.
 */
function dataDir(): string {
  return process.env.SENTINEL_DATA_HOME || DATA_HOME
}

export interface ChatSession {
  id: string
  title: string
  botId: string | null
  mode: 'chat' | 'ask'
  messages: { role: 'user' | 'assistant'; content: string; ts: number }[]
  createdAt: number
  updatedAt: number
  ownerId?: number
}

export const MAIN_ID = 'main'
const MAX_MSGS = 32
const MAX_CHARS = 14000
const FILE = (): string => join(dataDir(), 'miniapp-sessions.json')

type Store = Record<string, ChatSession>

function mkMain(): ChatSession {
  const t = Date.now()
  return { id: MAIN_ID, title: 'Main', botId: null, mode: 'chat', messages: [], createdAt: t, updatedAt: t }
}

function load(): Store {
  try {
    const s = JSON.parse(readFileSync(FILE(), 'utf8')) as Store
    if (!s[MAIN_ID]) s[MAIN_ID] = mkMain()
    return s
  } catch {
    return { [MAIN_ID]: mkMain() }
  }
}

function save(s: Store): void {
  const f = FILE()
  if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(s))
}

/** Returns the per-tenant main session id. Each uid gets their own main chat. */
export function mainIdFor(uid: number): string {
  return 'main:' + uid
}

/**
 * Returns the session only if it belongs to `uid`.
 * Returns null for cross-tenant access attempts.
 */
export function getSessionFor(uid: number, id: string): ChatSession | null {
  const s = load()[id] ?? null
  if (!s) return null
  if (s.ownerId != null && s.ownerId !== uid) return null
  return s
}

/** List all sessions owned by `uid`, optionally filtered by botId. */
export function listSessions(uid: number, botId?: string | null): ChatSession[] {
  const all = Object.values(load()).filter((x) => x.ownerId === uid)
  const f = botId === undefined ? all : all.filter((x) => x.botId === botId)
  return f.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getSession(id: string): ChatSession | null {
  return load()[id] ?? null
}

export function createSession(o: { ownerId: number; botId: string | null; mode: 'chat' | 'ask'; title?: string }): ChatSession {
  const s = load()
  const t = Date.now()
  const sess: ChatSession = {
    id: randomUUID(),
    title: o.title || 'New chat',
    botId: o.botId,
    mode: o.mode,
    messages: [],
    createdAt: t,
    updatedAt: t,
    ownerId: o.ownerId
  }
  s[sess.id] = sess
  save(s)
  return sess
}

export function renameSession(id: string, title: string): ChatSession | null {
  const s = load()
  if (!s[id]) return null
  s[id].title = title.slice(0, 80)
  s[id].updatedAt = Date.now()
  save(s)
  return s[id]
}

export function deleteSession(id: string): boolean {
  if (id === MAIN_ID) return false
  const s = load()
  if (!s[id]) return false
  delete s[id]
  save(s)
  return true
}

export function resetSession(id: string): ChatSession | null {
  const s = load()
  if (!s[id]) return null
  s[id].messages = []
  s[id].updatedAt = Date.now()
  save(s)
  return s[id]
}

export function appendTurn(id: string, user: string, assistant: string): void {
  const s = load()
  const sess = s[id]
  if (!sess) return
  const ts = Date.now()
  sess.messages.push({ role: 'user', content: user, ts }, { role: 'assistant', content: assistant, ts })
  while (sess.messages.length > MAX_MSGS) sess.messages.shift()
  let total = sess.messages.reduce((n, m) => n + m.content.length, 0)
  while (total > MAX_CHARS && sess.messages.length > 2) {
    total -= sess.messages.shift()!.content.length
  }
  sess.updatedAt = ts
  save(s)
}
