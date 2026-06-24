/**
 * Shared "commits behind origin" cache for git-sourced bots.
 *
 * This is the single place that performs the NETWORK `git fetch` to learn how
 * far behind each bot is. The monitor writes the cache on a throttled cadence;
 * the supervisor reads it on the hot `listBots` path so `runtimeOf` never pays a
 * network cost. To stay cycle-free this module is leaf-level: it imports the git
 * helpers and paths only — never monitor.ts or supervisor.ts.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Bot } from '@shared/types'
import { checkForUpdates } from './git'
import { DATA_HOME } from './paths'

/** botId -> commits behind origin (last known). */
const behindCache = new Map<string, number>()

const CACHE_FILE = join(DATA_HOME, 'update-counts.json')

/** Load the persisted counts so they survive a restart (best-effort). */
function loadCache(): void {
  try {
    const obj = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, number>
    for (const [id, n] of Object.entries(obj)) {
      if (typeof n === 'number' && Number.isFinite(n)) behindCache.set(id, n)
    }
  } catch {
    /* no cache yet, or unreadable — start empty */
  }
}
loadCache()

/** Persist the current counts (best-effort; a failed write must never throw). */
function saveCache(): void {
  try {
    const obj: Record<string, number> = {}
    for (const [id, n] of behindCache) obj[id] = n
    mkdirSync(dirname(CACHE_FILE), { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify(obj))
  } catch {
    /* best-effort persistence */
  }
}

/** Read the cached commits-behind for a bot. null = unknown / not a git bot. */
export function getUpdatesBehind(id: string): number | null {
  const n = behindCache.get(id)
  return n == null ? null : n
}

/** Internal setter — only refreshUpdateCounts (and a reset) touch the cache. */
function setUpdatesBehind(id: string, behind: number): void {
  behindCache.set(id, behind)
}

/** Clear a bot's count (e.g. right after it has been updated). */
export function clearUpdatesBehind(id: string): void {
  if (behindCache.delete(id)) saveCache()
}

/**
 * Hit the network once per git-sourced bot: `git fetch` + count commits behind
 * origin, and store the result. Per-bot errors are swallowed so one unreachable
 * remote never blocks the rest. This is the ONLY place that touches the network.
 */
export async function refreshUpdateCounts(bots: Bot[]): Promise<void> {
  let changed = false
  for (const bot of bots) {
    if (bot.manifest.source.type !== 'git') continue
    try {
      const res = await checkForUpdates(bot.dir)
      if (!res.isGit) continue
      const prev = behindCache.get(bot.manifest.id)
      if (prev !== res.behind) {
        setUpdatesBehind(bot.manifest.id, res.behind)
        changed = true
      }
    } catch {
      /* unreachable remote / transient git error — keep the last known count */
    }
  }
  if (changed) saveCache()
}
