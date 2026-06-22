/**
 * The always-on background monitor: a launchd LaunchAgent that relaunches
 * Sentinel itself in headless `--agent` mode, so crash-loop give-up, crash
 * notifications, and scheduled auto-updates keep working even when the GUI is
 * closed. Reuses the per-bot launchd machinery under the reserved id "monitor".
 */
import { existsSync } from 'node:fs'
import * as launchctl from './launchctl'
import { plistPath, botLogPaths, SENTINEL_HOME } from './paths'

const MONITOR_ID = 'monitor'

export function monitorAgentInstalled(): boolean {
  return existsSync(plistPath(MONITOR_ID))
}

/**
 * Install + load the monitor agent. `programArgs` is the argv that launches
 * Sentinel headless — e.g. ["/Applications/Sentinel.app/Contents/MacOS/Sentinel", "--agent"].
 */
export async function installMonitorAgent(programArgs: string[]): Promise<void> {
  const logs = botLogPaths(MONITOR_ID)
  await launchctl.installAgent(MONITOR_ID, {
    label: `com.sentinel.${MONITOR_ID}`,
    programArgs,
    workingDir: SENTINEL_HOME,
    stdoutPath: logs.out,
    stderrPath: logs.err,
    restartPolicy: 'always',
    runAtLoad: true,
    throttleInterval: 10,
    env: { SENTINEL_AGENT: '1' }
  })
}

export async function uninstallMonitorAgent(): Promise<void> {
  await launchctl.uninstallAgent(MONITOR_ID)
}

/** Bounce the installed agent so it re-reads config (e.g. control toggled). */
export async function restartMonitorAgent(): Promise<void> {
  if (monitorAgentInstalled()) await launchctl.restart(MONITOR_ID)
}
