import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { BotManifest } from '@shared/types'
import { REGISTRY_PATH, BOTS_DIR, ensureDirs } from './paths'

export interface RegistryEntry {
  id: string
  name: string
  /** Directory name under bots/. */
  dirName: string
}

export function readRegistry(): RegistryEntry[] {
  if (!existsSync(REGISTRY_PATH)) return []
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as RegistryEntry[]
  } catch {
    return []
  }
}

export function writeRegistry(entries: RegistryEntry[]): void {
  ensureDirs()
  writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2) + '\n', 'utf8')
}

export function addToRegistry(entry: RegistryEntry): void {
  const entries = readRegistry().filter((e) => e.id !== entry.id)
  entries.push(entry)
  writeRegistry(entries)
}

export function removeFromRegistry(id: string): void {
  writeRegistry(readRegistry().filter((e) => e.id !== id))
}

export function findEntry(id: string): RegistryEntry | undefined {
  return readRegistry().find((e) => e.id === id)
}

// ---- manifests ----

export function manifestPath(dir: string): string {
  return join(dir, 'sentinel.json')
}

export function readManifest(dir: string): BotManifest | null {
  const p = manifestPath(dir)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as BotManifest
  } catch {
    return null
  }
}

export function writeManifest(dir: string, manifest: BotManifest): void {
  writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

// ---- ids & dir names ----

export function newId(): string {
  return randomBytes(4).toString('hex')
}

/** Slugify a name into a filesystem-safe, unique directory name under bots/. */
export function uniqueDirName(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'bot'
  let candidate = base
  let n = 2
  while (existsSync(join(BOTS_DIR, candidate))) {
    candidate = `${base}-${n++}`
  }
  return candidate
}

/**
 * Copy a local project folder into bots/, excluding virtualenvs, caches, and
 * VCS metadata (these contain absolute paths or bloat and are recreated).
 */
export function copyLocalInto(src: string, destDirName: string): string {
  ensureDirs()
  const dest = join(BOTS_DIR, destDirName)
  const SKIP = new Set([
    '.venv',
    'venv',
    'node_modules',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    '.git',
    '.DS_Store'
  ])
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      const parts = source.split('/')
      return !parts.some((p) => SKIP.has(p))
    }
  })
  return dest
}

/** Delete a bot's directory under bots/ (used on remove). */
export function deleteBotDir(dirName: string): void {
  const dir = join(BOTS_DIR, dirName)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}
