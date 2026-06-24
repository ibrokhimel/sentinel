import { writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { exec, execOut } from './exec'
import { plistPath, botLabel, LAUNCH_AGENTS_DIR } from './paths'
import { buildPlist, type PlistConfig } from './plist'
import { mkdirSync } from 'node:fs'

let cachedUid: string | null = null
async function uid(): Promise<string> {
  if (cachedUid == null) cachedUid = await execOut('id', ['-u'])
  return cachedUid
}

async function domainTarget(label: string): Promise<string> {
  return `gui/${await uid()}/${label}`
}

export interface LaunchStatus {
  installed: boolean
  pid: number | null
  lastExitCode: number | null
  /** launchd's own notion: running | stopped | not-installed. */
  running: boolean
  /** Number of times launchd has spawned the job (approx restart count). */
  runs: number
}

/**
 * Clear any stale "disabled" override for this label in launchd's per-user
 * database. Sentinel never disables services itself, but a manual
 * `launchctl disable`, or some bootout/reboot sequences, can leave a label
 * flagged disabled — which makes `bootstrap` fail with "Input/output error"
 * (errno 5) AND silently neutralizes RunAtLoad/KeepAlive, stranding the bot
 * down forever. Enabling is idempotent and harmless when not disabled.
 */
export async function enable(botId: string): Promise<void> {
  await exec('launchctl', ['enable', await domainTarget(botLabel(botId))]).catch(() => undefined)
}

/** True if launchd has this label flagged "disabled" in its per-user override DB. */
export async function isDisabled(botId: string): Promise<boolean> {
  const r = await exec('launchctl', ['print-disabled', `gui/${await uid()}`])
  if (r.code !== 0) return false
  // Lines look like:  "com.sentinel.<id>" => disabled
  const re = new RegExp(`"${botLabel(botId)}"\\s*=>\\s*disabled`)
  return re.test(r.stdout)
}

/** Write the plist to ~/Library/LaunchAgents and bootstrap (load) it. */
export async function installAgent(botId: string, cfg: PlistConfig): Promise<void> {
  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true })
  const path = plistPath(botId)
  writeFileSync(path, buildPlist(cfg), 'utf8')

  // If already loaded, bootout first so the new plist takes effect.
  await bootout(botId).catch(() => undefined)

  // Always clear a stale "disabled" override before loading — otherwise
  // bootstrap fails with errno 5 and KeepAlive/RunAtLoad never fire.
  await enable(botId)

  const u = await uid()
  let res = await exec('launchctl', ['bootstrap', `gui/${u}`, path])
  if (res.code !== 0) {
    // "service already loaded" can happen if a prior bootout didn't fully take;
    // force another bootout and retry once.
    if (/already (loaded|bootstrapped)|service already/i.test(res.stderr)) {
      await bootout(botId)
      res = await exec('launchctl', ['bootstrap', `gui/${u}`, path])
    }
    // "Input/output error" (errno 5) here almost always means a lingering
    // disabled override or a half-torn-down registration; re-enable, force a
    // clean bootout, and retry once more.
    if (res.code !== 0 && /input\/output error|\b5:\s|disabled/i.test(res.stderr)) {
      await enable(botId)
      await bootout(botId).catch(() => undefined)
      res = await exec('launchctl', ['bootstrap', `gui/${u}`, path])
    }
    if (res.code !== 0) {
      throw new Error(`launchctl bootstrap failed (code ${res.code}): ${(res.stderr || res.stdout).trim()}`)
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** True if the labeled job is currently known to launchd. */
async function isLoaded(label: string): Promise<boolean> {
  const r = await exec('launchctl', ['print', await domainTarget(label)])
  return r.code === 0
}

/**
 * Bootout (unload) the agent, retrying through the well-known transient
 * "Boot-out failed: 5: Input/output error" that launchd returns even when the
 * unload eventually succeeds. Verifies the job is actually gone. Does not delete
 * the plist file.
 */
export async function bootout(botId: string): Promise<void> {
  const label = botLabel(botId)
  const target = await domainTarget(label)
  if (!(await isLoaded(label))) return

  for (let attempt = 0; attempt < 5; attempt++) {
    await exec('launchctl', ['bootout', target])
    await sleep(300)
    if (!(await isLoaded(label))) return
  }
  // Last resort: it's still loaded. Surface a clear error so callers can react.
  if (await isLoaded(label)) {
    throw new Error(`Could not unload ${label} (launchd kept it loaded after retries).`)
  }
}

/** Bootout and remove the plist file entirely. */
export async function uninstallAgent(botId: string): Promise<void> {
  await bootout(botId).catch(() => undefined)
  const path = plistPath(botId)
  if (existsSync(path)) {
    try {
      unlinkSync(path)
    } catch {
      /* ignore */
    }
  }
}

/** Kill and immediately relaunch the job (no unload/reload needed). */
export async function restart(botId: string): Promise<void> {
  const target = await domainTarget(botLabel(botId))
  const res = await exec('launchctl', ['kickstart', '-k', target])
  if (res.code !== 0) {
    throw new Error(`launchctl kickstart failed: ${(res.stderr || res.stdout).trim()}`)
  }
}

/** Start a loaded-but-stopped job. */
export async function start(botId: string): Promise<void> {
  const target = await domainTarget(botLabel(botId))
  await exec('launchctl', ['kickstart', target])
}

/**
 * Read status of a labeled job. Uses `launchctl print` (rich) and falls back to
 * `launchctl list <label>` for the legacy parseable block.
 */
export async function status(botId: string): Promise<LaunchStatus> {
  const label = botLabel(botId)
  if (!existsSync(plistPath(botId))) {
    return { installed: false, pid: null, lastExitCode: null, running: false, runs: 0 }
  }
  const target = await domainTarget(label)
  const printed = await exec('launchctl', ['print', target])
  if (printed.code === 0) {
    return parsePrint(printed.stdout)
  }
  // Fallback: legacy list.
  const listed = await exec('launchctl', ['list', label])
  if (listed.code === 0) {
    return parseList(listed.stdout)
  }
  // Plist exists but not loaded.
  return { installed: true, pid: null, lastExitCode: null, running: false, runs: 0 }
}

function parsePrint(out: string): LaunchStatus {
  const pidM = out.match(/\bpid\s*=\s*(\d+)/)
  const stateM = out.match(/\bstate\s*=\s*(\w[\w\s]*)/)
  const exitM =
    out.match(/last exit code\s*=\s*(\d+)/i) ||
    out.match(/last exit status\s*=\s*(\d+)/i)
  const pid = pidM ? parseInt(pidM[1], 10) : null
  const running = pid != null || (stateM ? /running/i.test(stateM[1]) : false)
  const runsM = out.match(/\bruns\s*=\s*(\d+)/)
  return {
    installed: true,
    pid,
    lastExitCode: exitM ? parseInt(exitM[1], 10) : null,
    running,
    runs: runsM ? parseInt(runsM[1], 10) : 0
  }
}

function parseList(out: string): LaunchStatus {
  const pidM = out.match(/"PID"\s*=\s*(\d+)/)
  const exitM = out.match(/"LastExitStatus"\s*=\s*(-?\d+)/)
  const pid = pidM ? parseInt(pidM[1], 10) : null
  return {
    installed: true,
    pid,
    lastExitCode: exitM ? parseInt(exitM[1], 10) : null,
    running: pid != null,
    runs: 0
  }
}
