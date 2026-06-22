import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * Sentinel keeps everything the user cares about inside ~/Documents/Sentinel —
 * by explicit request, the managed bot files live "inside this folder". This is
 * derived from the home directory (not from the app bundle location) so it is
 * the same in `electron-vite dev` and in a packaged .app.
 */
export const SENTINEL_HOME = join(homedir(), 'Documents', 'Sentinel')

/**
 * Bot data (folders + logs) lives OUTSIDE ~/Documents. macOS TCC blocks
 * launchd-spawned processes (the bots' python) from reading ~/Documents, so a
 * venv there fails with "Operation not permitted". Application Support is not
 * protected, so bots run cleanly. Config + registry stay in SENTINEL_HOME since
 * only the (TCC-granted) Electron process reads them.
 */
export const DATA_HOME = join(homedir(), 'Library', 'Application Support', 'Sentinel')

export const BOTS_DIR = join(DATA_HOME, 'bots')
export const LOGS_DIR = join(DATA_HOME, 'logs')
export const REGISTRY_PATH = join(SENTINEL_HOME, 'registry.json')

/** Per-user LaunchAgents directory where Sentinel installs its plists. */
export const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents')

/** launchd label prefix; full label is `${LABEL_PREFIX}.<botId>`. */
export const LABEL_PREFIX = 'com.sentinel'

export function botLabel(botId: string): string {
  return `${LABEL_PREFIX}.${botId}`
}

export function botDir(dirName: string): string {
  return join(BOTS_DIR, dirName)
}

export function plistPath(botId: string): string {
  return join(LAUNCH_AGENTS_DIR, `${botLabel(botId)}.plist`)
}

export function botLogPaths(botId: string): { out: string; err: string } {
  return {
    out: join(LOGS_DIR, `${botId}.out.log`),
    err: join(LOGS_DIR, `${botId}.err.log`)
  }
}

/** Ensure the base directory tree exists. Safe to call repeatedly. */
export function ensureDirs(): void {
  for (const d of [SENTINEL_HOME, DATA_HOME, BOTS_DIR, LOGS_DIR, LAUNCH_AGENTS_DIR]) {
    mkdirSync(d, { recursive: true })
  }
}
