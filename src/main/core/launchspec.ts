import { join, isAbsolute } from 'node:path'
import type { BotManifest } from '@shared/types'
import { MINIAPP_WRAPPER, isNodePm, resolveBinSync } from './node'

/**
 * Resolve a manifest's interpreter + entry into a concrete argv to execute,
 * given the bot's absolute directory.
 *
 * Special entry form `__script__:<name>` means "run the console script the
 * package installed into the venv" (.venv/bin/<name>), with no python prefix.
 */
export function resolveArgv(manifest: BotManifest, dir: string): string[] {
  if (manifest.runtime === 'node') return resolveNodeArgv(manifest, dir)

  const first = manifest.entry[0]
  if (first && first.startsWith('__script__:')) {
    const scriptName = first.slice('__script__:'.length)
    const scriptPath = join(dir, '.venv', 'bin', scriptName)
    return [scriptPath, ...manifest.entry.slice(1)]
  }

  const python = isAbsolute(manifest.python) ? manifest.python : join(dir, manifest.python)
  return [python, ...manifest.entry]
}

/**
 * Resolve argv for a Node bot:
 *   __miniapp__         → bash <dir>/.sentinel-miniapp.sh (server + tunnel + menu button)
 *   __npm__:<script>    → <pm> run <script>
 *   __nodefile__ <file> → node <file> [args]
 */
function resolveNodeArgv(manifest: BotManifest, dir: string): string[] {
  const [first, ...rest] = manifest.entry
  if (first === '__miniapp__') {
    return ['/bin/bash', join(dir, MINIAPP_WRAPPER)]
  }
  if (first && first.startsWith('__npm__:')) {
    const script = first.slice('__npm__:'.length)
    const pm = isNodePm(manifest.packageManager) ? manifest.packageManager : 'npm'
    return [resolveBinSync(pm) ?? pm, 'run', script]
  }
  if (first === '__nodefile__') {
    return [resolveBinSync('node') ?? 'node', ...rest]
  }
  // Fallback: treat the whole entry as a node invocation target.
  return [resolveBinSync('node') ?? 'node', ...manifest.entry]
}
