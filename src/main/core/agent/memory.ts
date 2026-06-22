/**
 * Persistent conversation memory for the AI surfaces (/ai, /dev, /ask, /fix).
 *
 * Each invocation used to start from scratch, so the assistant "forgot"
 * everything between messages. This keeps a small rolling history per chat, per
 * thread, on disk (so it also survives a restart of the agent process), and
 * feeds it back into the next turn as prior context.
 *
 * We store ONLY clean user/assistant text turns — never tool-call plumbing or
 * secrets — so the history stays small and safe to re-send.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_HOME } from '../paths'
import type { ChatMessage } from './provider'

const FILE = join(DATA_HOME, 'conversations.json')
/** Keep at most this many turns (a turn = one user + one assistant message). */
const MAX_TURNS = 16
/** Hard cap on a thread's total characters; oldest turns are dropped first. */
const MAX_CHARS = 14000

type Turn = { role: 'user' | 'assistant'; content: string }
type Store = Record<string, Turn[]>

/** Thread id: keep /ai, /dev, and each bot's /ask|/fix as separate memories. */
export type Thread = 'chat' | 'self' | `bot:${string}`

function keyFor(chatId: number, thread: Thread): string {
  return `${chatId}:${thread}`
}

function load(): Store {
  try {
    if (!existsSync(FILE)) return {}
    return JSON.parse(readFileSync(FILE, 'utf8')) as Store
  } catch {
    return {}
  }
}

function save(store: Store): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    writeFileSync(FILE, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* best effort — memory is a nicety, never fatal */
  }
}

function trim(turns: Turn[]): Turn[] {
  // Cap by turn count first (drop oldest pairs).
  while (turns.length > MAX_TURNS * 2) turns.splice(0, 2)
  // Then by total size.
  let total = turns.reduce((n, t) => n + t.content.length, 0)
  while (total > MAX_CHARS && turns.length > 2) {
    const dropped = turns.splice(0, 2)
    total -= dropped.reduce((n, t) => n + t.content.length, 0)
  }
  return turns
}

/** Prior turns for a thread, as chat messages ready to splice after the system prompt. */
export function getHistory(chatId: number, thread: Thread): ChatMessage[] {
  const turns = load()[keyFor(chatId, thread)] ?? []
  return turns.map((t) => ({ role: t.role, content: t.content }))
}

/** Record one exchange. No-ops on empty content so we don't store dead turns. */
export function appendTurn(chatId: number, thread: Thread, user: string, assistant: string): void {
  const u = (user ?? '').trim()
  const a = (assistant ?? '').trim()
  if (!u || !a) return
  const store = load()
  const k = keyFor(chatId, thread)
  const turns = store[k] ?? []
  turns.push({ role: 'user', content: u }, { role: 'assistant', content: a })
  store[k] = trim(turns)
  save(store)
}

/** Clear one thread, or (no thread) every thread for this chat. Returns count cleared. */
export function clearMemory(chatId: number, thread?: Thread): number {
  const store = load()
  let cleared = 0
  if (thread) {
    if (store[keyFor(chatId, thread)]) {
      delete store[keyFor(chatId, thread)]
      cleared = 1
    }
  } else {
    const prefix = `${chatId}:`
    for (const k of Object.keys(store)) {
      if (k.startsWith(prefix)) {
        delete store[k]
        cleared++
      }
    }
  }
  if (cleared) save(store)
  return cleared
}
