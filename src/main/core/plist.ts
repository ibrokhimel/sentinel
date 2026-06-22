import type { RestartPolicy } from '@shared/types'

export interface PlistConfig {
  label: string
  /** Full argv, e.g. ["/abs/.venv/bin/python", "run.py", "--verbose"]. */
  programArgs: string[]
  workingDir: string
  stdoutPath: string
  stderrPath: string
  restartPolicy: RestartPolicy
  /** Start on login/boot. */
  runAtLoad: boolean
  /** Minimum seconds between respawns (launchd default 10). */
  throttleInterval?: number
  /** Extra environment variables to inject into the launchd job. */
  env?: Record<string, string>
  /** Run every N seconds (scheduled jobs; mutually exclusive with KeepAlive intent). */
  startInterval?: number
  /** Run at a calendar time (any omitted field is a wildcard). */
  startCalendar?: { hour?: number; minute?: number; weekday?: number }
}

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function keepAliveBlock(policy: RestartPolicy): string {
  switch (policy) {
    case 'always':
      return '  <key>KeepAlive</key>\n  <true/>'
    case 'on-crash':
      // Restart unless the process exited cleanly (exit code 0).
      return [
        '  <key>KeepAlive</key>',
        '  <dict>',
        '    <key>SuccessfulExit</key>',
        '    <false/>',
        '  </dict>'
      ].join('\n')
    case 'never':
      return '  <key>KeepAlive</key>\n  <false/>'
  }
}

/** Build the XML body of a launchd LaunchAgent plist. */
export function buildPlist(cfg: PlistConfig): string {
  const args = cfg.programArgs
    .map((a) => `    <string>${esc(a)}</string>`)
    .join('\n')

  const envBlock = cfg.env && Object.keys(cfg.env).length
    ? [
        '  <key>EnvironmentVariables</key>',
        '  <dict>',
        ...Object.entries(cfg.env).flatMap(([k, v]) => [
          `    <key>${esc(k)}</key>`,
          `    <string>${esc(v)}</string>`
        ]),
        '  </dict>'
      ].join('\n')
    : ''

  const scheduleBlock = buildScheduleBlock(cfg)

  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${esc(cfg.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${esc(cfg.workingDir)}</string>`,
    keepAliveBlock(cfg.restartPolicy),
    '  <key>RunAtLoad</key>',
    cfg.runAtLoad ? '  <true/>' : '  <false/>',
    '  <key>ThrottleInterval</key>',
    `  <integer>${cfg.throttleInterval ?? 10}</integer>`,
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    scheduleBlock,
    envBlock,
    '  <key>StandardOutPath</key>',
    `  <string>${esc(cfg.stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${esc(cfg.stderrPath)}</string>`,
    '</dict>',
    '</plist>',
    ''
  ].filter((l) => l !== '')

  return parts.join('\n')
}

function buildScheduleBlock(cfg: PlistConfig): string {
  if (cfg.startInterval && cfg.startInterval > 0) {
    return `  <key>StartInterval</key>\n  <integer>${Math.floor(cfg.startInterval)}</integer>`
  }
  if (cfg.startCalendar) {
    const c = cfg.startCalendar
    const entries: string[] = []
    if (c.hour != null) entries.push('    <key>Hour</key>', `    <integer>${c.hour}</integer>`)
    if (c.minute != null) entries.push('    <key>Minute</key>', `    <integer>${c.minute}</integer>`)
    if (c.weekday != null) entries.push('    <key>Weekday</key>', `    <integer>${c.weekday}</integer>`)
    if (entries.length) {
      return ['  <key>StartCalendarInterval</key>', '  <dict>', ...entries, '  </dict>'].join('\n')
    }
  }
  return ''
}
