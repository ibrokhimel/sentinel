import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Bot,
  BotManifest,
  BotRuntime,
  BotStatus,
  DetectResult,
  ImportRequest,
  UpdateCheck
} from '@shared/types'
import { BOTS_DIR, botDir, botLabel, botLogPaths, ensureDirs } from './paths'
import {
  addToRegistry,
  copyLocalInto,
  deleteBotDir,
  findEntry,
  newId,
  readManifest,
  readRegistry,
  removeFromRegistry,
  uniqueDirName,
  writeManifest
} from './registry'
import { detect } from './detect'
import {
  changedFiles,
  checkForUpdates,
  clone,
  currentSha,
  defaultBranch,
  nameFromUrl,
  pull,
  pushLive as pushLiveGit,
  resetHard
} from './git'
import { getGithubToken } from './config'
import { getUpdatesBehind } from './updates'
import { interpreterPath, setupEnv, venvReady } from './venv'
import { miniAppWrapperSpec, nodeDepsReady, setupNode, writeMiniAppWrapper } from './node'
import { readEnvExample, readEnvFile, writeEnvFile } from './env'
import { procStat, cputimeToSec } from './stats'
import * as launchctl from './launchctl'
import { resolveArgv } from './launchspec'
import { basename } from 'node:path'

/** Dependency manifest files that, when changed, require a reinstall. */
const PY_DEP_FILES = ['requirements.txt', 'pyproject.toml', 'uv.lock', 'poetry.lock', 'Pipfile', 'Pipfile.lock']
const NODE_DEP_FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']

type Log = (s: string) => void

/** A bot's interpreter family (manifests predating Node default to python). */
function runtimeOfManifest(manifest: BotManifest): 'python' | 'node' {
  return manifest.runtime === 'node' ? 'node' : 'python'
}

/** Whether a bot's dependencies are installed (venv for python, node_modules for node). */
function envReadyFor(dir: string, manifest: BotManifest): boolean {
  return runtimeOfManifest(manifest) === 'node' ? nodeDepsReady(dir) : venvReady(dir)
}

/** Resolve a bot's directory + manifest by id. Throws if unknown. */
function locate(id: string): { dir: string; manifest: BotManifest } {
  const entry = findEntry(id)
  if (!entry) throw new Error(`Unknown bot: ${id}`)
  const dir = botDir(entry.dirName)
  const manifest = readManifest(dir)
  if (!manifest) throw new Error(`Bot ${id} has no sentinel.json manifest`)
  return { dir, manifest }
}

function statusFrom(ls: launchctl.LaunchStatus, manifest: BotManifest, restarts: number): BotStatus {
  if (!ls.installed) return 'not-installed'
  if (ls.running) {
    return restarts > manifest.maxRestarts ? 'crash-looping' : 'running'
  }
  if (ls.lastExitCode != null && ls.lastExitCode !== 0) return 'crashed'
  // A scheduled (non-always) bot that's installed and idle is "scheduled".
  if (manifest.schedule) return 'scheduled'
  if (ls.lastExitCode === 0) return 'stopped'
  return 'unknown'
}

async function runtimeOf(id: string, dir: string, manifest: BotManifest): Promise<BotRuntime> {
  const ls = await launchctl.status(id)
  const restarts = Math.max(0, ls.runs - (ls.running ? 1 : 0))
  // Fast (lifetime-avg CPU) here — runtimeOf runs for every bot on every list.
  const st = ls.running && ls.pid ? await procStat(ls.pid) : { cpu: null, memMB: null, memPct: null, uptime: null }
  return {
    label: botLabel(id),
    status: statusFrom(ls, manifest, restarts),
    pid: ls.pid,
    lastExitCode: ls.lastExitCode,
    restarts,
    installed: ls.installed,
    envReady: envReadyFor(dir, manifest),
    envFilePresent: existsSync(join(dir, manifest.envFile)),
    cpu: st.cpu,
    memMB: st.memMB,
    memPct: st.memPct,
    uptime: st.uptime,
    uptimeSec: st.uptime ? cputimeToSec(st.uptime) : null,
    // Read-only: the monitor refreshes this cache on a throttled cadence so the
    // hot listBots path never hits the network here.
    updatesBehind: getUpdatesBehind(id)
  }
}

export async function listBots(): Promise<Bot[]> {
  ensureDirs()
  const out: Bot[] = []
  for (const entry of readRegistry()) {
    const dir = botDir(entry.dirName)
    const manifest = readManifest(dir)
    if (!manifest) continue
    out.push({ manifest, dir, runtime: await runtimeOf(entry.id, dir, manifest) })
  }
  return out
}

export async function getBot(id: string): Promise<Bot> {
  const { dir, manifest } = locate(id)
  return { manifest, dir, runtime: await runtimeOf(id, dir, manifest) }
}

/**
 * Import a project: clone (git) or copy (local) into bots/, auto-detect how to
 * run it, write a sentinel.json manifest, and register it. Does NOT set up the
 * venv or start it — those are explicit follow-up steps.
 */
export async function importBot(
  req: ImportRequest,
  log: Log = () => {}
): Promise<{ bot: Bot; detect: DetectResult }> {
  ensureDirs()
  const id = newId()
  const displayName = req.name?.trim() || (req.type === 'git' ? nameFromUrl(req.source) : basename(req.source))
  const dirName = uniqueDirName(displayName)
  const dest = join(BOTS_DIR, dirName)

  let branch = req.branch
  if (req.type === 'git') {
    log(`Cloning ${req.source} ...\n`)
    await clone(req.source, dest, { token: req.token, branch: req.branch, onData: log })
    branch = branch ?? (await defaultBranch(dest)) ?? undefined
  } else {
    if (!existsSync(req.source)) throw new Error(`Folder does not exist: ${req.source}`)
    log(`Copying ${req.source} into ${dest} ...\n`)
    copyLocalInto(req.source, dirName)
  }

  const det = detect(dest)
  log(`Detected: ${det.notes.join(' ')}\n`)

  const miniApp =
    det.runtime === 'node' && det.miniApp
      ? {
          enabled: true,
          script: det.miniApp.script,
          port: det.miniApp.port,
          tunnel: 'cloudflared' as const,
          webFramework: det.miniApp.webFramework,
          setMenuButton: true,
          menuText: 'Open App'
        }
      : undefined

  const manifest: BotManifest = {
    id,
    name: displayName,
    source: {
      type: req.type,
      origin: req.source,
      branch
    },
    runtime: det.runtime,
    packageManager: det.packageManager,
    python: det.python,
    entry: det.entry,
    envFile: '.env',
    envKeys: det.envKeys,
    restartPolicy: 'always',
    maxRestarts: 10,
    autostart: true,
    createdAt: new Date().toISOString(),
    framework: det.framework,
    autoUpdate: false,
    updateIntervalHours: 6,
    notifyOnCrash: true,
    miniApp
  }
  writeManifest(dest, manifest)
  addToRegistry({ id, name: displayName, dirName })

  return { bot: { manifest, dir: dest, runtime: await runtimeOf(id, dest, manifest) }, detect: det }
}

/** Merge fields into a bot's manifest and persist. */
export async function updateManifest(id: string, patch: Partial<BotManifest>): Promise<Bot> {
  const { dir, manifest } = locate(id)
  const next: BotManifest = { ...manifest, ...patch, id: manifest.id, createdAt: manifest.createdAt }
  writeManifest(dir, next)
  return { manifest: next, dir, runtime: await runtimeOf(id, dir, next) }
}

// ---- env / secrets ----

export function getEnv(id: string): {
  keys: string[]
  example: Record<string, string>
  current: Record<string, string>
} {
  const { dir, manifest } = locate(id)
  const example = readEnvExample(dir)
  const current = readEnvFile(dir, manifest.envFile)
  const keys = Array.from(new Set([...manifest.envKeys, ...Object.keys(example), ...Object.keys(current)]))
  return { keys, example, current }
}

export async function saveEnv(id: string, values: Record<string, string>): Promise<void> {
  const { dir, manifest } = locate(id)
  writeEnvFile(dir, values, manifest.envFile)
  // Keep the manifest's key list in sync (names only).
  await updateManifest(id, { envKeys: Object.keys(values) })
}

// ---- environment setup ----

export async function setupBotEnv(id: string, log: Log): Promise<Bot> {
  const { dir, manifest } = locate(id)
  if (runtimeOfManifest(manifest) === 'node') {
    await setupNode(dir, manifest.packageManager, log)
    return getBot(id)
  }
  const { python } = await setupEnv(dir, manifest.packageManager, log)
  return updateManifest(id, { python })
}

// ---- launchd control ----

function plistConfigFor(id: string, dir: string, manifest: BotManifest) {
  const argv = resolveArgv(manifest, dir)
  // Make the interpreter path absolute (it may be stored relative).
  if (!argv[0].startsWith('/')) argv[0] = join(dir, argv[0])
  const logs = botLogPaths(id)
  const sched = manifest.schedule
  return {
    label: botLabel(id),
    programArgs: argv,
    workingDir: dir,
    stdoutPath: logs.out,
    stderrPath: logs.err,
    // A scheduled bot runs to completion each tick — never KeepAlive, never RunAtLoad.
    restartPolicy: sched ? ('never' as const) : manifest.restartPolicy,
    runAtLoad: sched ? false : manifest.autostart,
    throttleInterval: 10,
    startInterval: sched?.kind === 'interval' ? sched.intervalSeconds : undefined,
    startCalendar: sched?.kind === 'calendar' ? sched.calendar : undefined
  }
}

/**
 * For a Mini App, (re)generate the launch wrapper just before start so it picks
 * up the latest config + a fresh tunnel URL on every restart. Throws a clear
 * error if cloudflared is needed but missing.
 */
function prepareMiniApp(dir: string, manifest: BotManifest): void {
  if (runtimeOfManifest(manifest) !== 'node' || !manifest.miniApp?.enabled) return
  const spec = miniAppWrapperSpec(dir, manifest.packageManager, manifest.miniApp)
  writeMiniAppWrapper(spec)
}

/** Generate the plist and bootstrap the agent (starts now + at boot if autostart). */
export async function start(id: string): Promise<Bot> {
  const { dir, manifest } = locate(id)
  if (!envReadyFor(dir, manifest)) {
    throw new Error('Environment not set up yet — run "Set up environment" first.')
  }
  if (manifest.entry.length === 0) {
    throw new Error('No entry point set — edit the bot to set how it launches.')
  }
  prepareMiniApp(dir, manifest)
  await launchctl.installAgent(id, plistConfigFor(id, dir, manifest))
  return getBot(id)
}

/** Stop and unload the agent (plist file stays on disk). */
export async function stop(id: string): Promise<Bot> {
  await launchctl.bootout(id)
  return getBot(id)
}

/** Restart in place; if not loaded, (re)install first. */
export async function restart(id: string): Promise<Bot> {
  const { dir, manifest } = locate(id)
  const ls = await launchctl.status(id)
  if (!ls.installed) {
    prepareMiniApp(dir, manifest)
    await launchctl.installAgent(id, plistConfigFor(id, dir, manifest))
  } else {
    await launchctl.restart(id)
  }
  return getBot(id)
}

/** Toggle RunAtLoad (autostart on login/boot); rewrites + reloads the plist. */
export async function setAutostart(id: string, autostart: boolean): Promise<Bot> {
  const bot = await updateManifest(id, { autostart })
  // Only reinstall if it's currently installed, to apply the new RunAtLoad.
  const ls = await launchctl.status(id)
  if (ls.installed) {
    prepareMiniApp(bot.dir, bot.manifest)
    await launchctl.installAgent(id, plistConfigFor(id, bot.dir, bot.manifest))
  }
  return getBot(id)
}

/** Remove a bot entirely: bootout, delete plist, delete dir, drop registry. */
export async function removeBot(id: string): Promise<void> {
  const entry = findEntry(id)
  await launchctl.uninstallAgent(id)
  if (entry) deleteBotDir(entry.dirName)
  removeFromRegistry(id)
}

/** Check (without changing anything) how many commits behind origin a bot is. */
export async function checkUpdates(id: string): Promise<UpdateCheck> {
  const { dir } = locate(id)
  return checkForUpdates(dir)
}

/**
 * Snapshot the bot's current working tree (including AI-made `/fix` edits) to a
 * branch (default `sentinel-live`) and push it to origin, without disturbing the
 * running checkout. `token` overrides the stored GitHub token (e.g. a one-time
 * token supplied over Telegram). Throws a clear error if no token is available.
 */
export async function pushLive(
  id: string,
  log: Log,
  token?: string
): Promise<{ branch: string; commit: string; url: string | null }> {
  const { dir } = locate(id)
  const auth = (token && token.trim()) || getGithubToken()
  if (!auth) {
    throw new Error('No GitHub token set — add one in Preferences (or send one over Telegram) to push.')
  }
  const r = await pushLiveGit(dir, { token: auth, message: 'Sentinel live snapshot', onData: log })
  return { branch: r.branch, commit: r.commit, url: r.url }
}

/**
 * Full update pipeline for a git bot:
 *   record current SHA → pull → if dependency files changed, rebuild the venv →
 *   restart the running agent on the new code. Records the previous SHA as
 *   lastGoodSha for rollback.
 */
export async function updateBot(id: string, log: Log): Promise<Bot> {
  const { dir, manifest } = locate(id)
  if (manifest.source.type !== 'git') {
    throw new Error('This bot was imported from a local folder; there is nothing to pull.')
  }

  const before = await currentSha(dir)
  log(`Current commit: ${before ?? 'unknown'}\n`)
  await pull(dir, log)
  const after = await currentSha(dir)

  if (before && after && before === after) {
    log('Already up to date.\n')
    return getBot(id)
  }

  // Reinstall deps only if a dependency manifest changed in the diff.
  if (before && after) {
    const isNode = runtimeOfManifest(manifest) === 'node'
    const depFiles = isNode ? NODE_DEP_FILES : PY_DEP_FILES
    const changed = await changedFiles(dir, before, after)
    const depsChanged = changed.some((f) => depFiles.includes(basename(f)))
    if (depsChanged) {
      log('\nDependency files changed — rebuilding the environment...\n')
      if (isNode) await setupNode(dir, manifest.packageManager, log)
      else await setupEnv(dir, manifest.packageManager, log)
    } else {
      log('No dependency changes; skipping reinstall.\n')
    }
  }

  // Remember the new commit as last-good and restart the running bot on new code.
  if (after) await updateManifest(id, { lastGoodSha: after })
  const ls = await launchctl.status(id)
  if (ls.installed) {
    log('Restarting bot on the new code...\n')
    await launchctl.restart(id)
  }
  log('Update complete.\n')
  return getBot(id)
}

/**
 * Roll a bot back to a known-good commit (used after a bad update / crash-loop),
 * rebuild deps, and restart.
 */
export async function rollbackBot(id: string, sha: string, log: Log): Promise<Bot> {
  const { dir, manifest } = locate(id)
  log(`Rolling back to ${sha}...\n`)
  await resetHard(dir, sha, log)
  const reinstall =
    runtimeOfManifest(manifest) === 'node'
      ? setupNode(dir, manifest.packageManager, log)
      : setupEnv(dir, manifest.packageManager, log)
  await reinstall.catch((e) => log(`(reinstall failed: ${e})\n`))
  const ls = await launchctl.status(id)
  if (ls.installed) await launchctl.restart(id)
  return getBot(id)
}

/**
 * Stop a crash-looping bot (launchd never gives up on its own). Boots it out so
 * it stops hammering; the caller is expected to notify the user.
 */
export async function giveUp(id: string): Promise<Bot> {
  await launchctl.bootout(id)
  return getBot(id)
}

/** Apply the current manifest to launchd if the agent is installed (e.g. after a settings change). */
export async function reinstallIfRunning(id: string): Promise<Bot> {
  const { dir, manifest } = locate(id)
  const ls = await launchctl.status(id)
  if (ls.installed) {
    prepareMiniApp(dir, manifest)
    await launchctl.installAgent(id, plistConfigFor(id, dir, manifest))
  }
  return getBot(id)
}

/** Run the bot once in the foreground (test run) — returns the argv to spawn in a pty. */
export function testRunSpec(id: string): { argv: string[]; dir: string } {
  const { dir, manifest } = locate(id)
  const argv = resolveArgv(manifest, dir)
  if (!argv[0].startsWith('/')) argv[0] = join(dir, argv[0])
  return { argv, dir }
}

/** Absolute interpreter path (used by callers that need it). */
export function interpreterFor(id: string): string {
  const { dir } = locate(id)
  return interpreterPath(dir)
}
