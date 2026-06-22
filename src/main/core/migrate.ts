/**
 * One-time migration: move bot folders out of the old ~/Documents/Sentinel/bots
 * location (TCC-protected → launchd-spawned python is denied) into the new
 * Application Support data dir. Each .venv is dropped because a venv's paths are
 * absolute and break when moved — the user re-runs setup to rebuild it in the
 * new (TCC-free) location. The stale launchd agent is uninstalled. Idempotent.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BOTS_DIR } from './paths'
import { readRegistry } from './registry'
import * as launchctl from './launchctl'

const OLD_BOTS = join(homedir(), 'Documents', 'Sentinel', 'bots')

export async function migrateBotsOutOfDocuments(log: (s: string) => void = () => {}): Promise<string[]> {
  const moved: string[] = []
  if (OLD_BOTS === BOTS_DIR || !existsSync(OLD_BOTS)) return moved
  mkdirSync(BOTS_DIR, { recursive: true })

  const idByDir = new Map(readRegistry().map((e) => [e.dirName, e.id]))
  let names: string[] = []
  try {
    names = readdirSync(OLD_BOTS)
  } catch {
    return moved
  }

  for (const name of names) {
    const src = join(OLD_BOTS, name)
    try {
      if (!statSync(src).isDirectory()) continue
    } catch {
      continue
    }
    const dest = join(BOTS_DIR, name)
    if (existsSync(dest)) continue // already migrated

    // Remove the stale agent first — its plist points at the old path.
    const id = idByDir.get(name)
    if (id) {
      try {
        await launchctl.uninstallAgent(id)
      } catch {
        /* best effort */
      }
    }

    try {
      renameSync(src, dest)
    } catch {
      // Cross-volume fallback.
      cpSync(src, dest, { recursive: true })
      rmSync(src, { recursive: true, force: true })
    }

    // The moved venv has absolute paths baked in — drop it so setup rebuilds it.
    const venv = join(dest, '.venv')
    if (existsSync(venv)) {
      try {
        rmSync(venv, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
    moved.push(name)
    log(`Moved ${name} → ${dest} (venv cleared; re-run setup)`)
  }
  return moved
}
