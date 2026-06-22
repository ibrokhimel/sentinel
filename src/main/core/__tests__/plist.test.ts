import { describe, it, expect } from 'vitest'
import { buildPlist } from '../plist'

describe('buildPlist', () => {
  const base = {
    label: 'com.sentinel.abc123',
    programArgs: ['/Users/me/bots/wd/.venv/bin/python', 'run.py', '--verbose'],
    workingDir: '/Users/me/bots/wd',
    stdoutPath: '/Users/me/logs/abc123.out.log',
    stderrPath: '/Users/me/logs/abc123.err.log',
    runAtLoad: true
  }

  it('produces valid plist with label, args, and working dir', () => {
    const xml = buildPlist({ ...base, restartPolicy: 'always' })
    expect(xml).toContain('<plist version="1.0">')
    expect(xml).toContain('<string>com.sentinel.abc123</string>')
    expect(xml).toContain('<string>/Users/me/bots/wd/.venv/bin/python</string>')
    expect(xml).toContain('<string>--verbose</string>')
    expect(xml).toContain('<key>WorkingDirectory</key>')
    expect(xml.trim().endsWith('</plist>')).toBe(true)
  })

  it('maps restartPolicy "always" to KeepAlive true', () => {
    const xml = buildPlist({ ...base, restartPolicy: 'always' })
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
  })

  it('maps restartPolicy "on-crash" to KeepAlive dict with SuccessfulExit false', () => {
    const xml = buildPlist({ ...base, restartPolicy: 'on-crash' })
    expect(xml).toContain('<key>SuccessfulExit</key>')
    expect(xml).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/)
  })

  it('honors RunAtLoad false', () => {
    const xml = buildPlist({ ...base, restartPolicy: 'never', runAtLoad: false })
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/)
  })

  it('escapes XML special characters in args', () => {
    const xml = buildPlist({
      ...base,
      programArgs: ['/bin/python', 'a&b<c>.py'],
      restartPolicy: 'always'
    })
    expect(xml).toContain('a&amp;b&lt;c&gt;.py')
    expect(xml).not.toContain('a&b<c>.py')
  })

  it('includes environment variables when provided', () => {
    const xml = buildPlist({
      ...base,
      restartPolicy: 'always',
      env: { FOO: 'bar' }
    })
    expect(xml).toContain('<key>EnvironmentVariables</key>')
    expect(xml).toContain('<key>FOO</key>')
    expect(xml).toContain('<string>bar</string>')
  })

  it('emits StartInterval for an interval schedule', () => {
    const xml = buildPlist({ ...base, restartPolicy: 'never', startInterval: 3600 })
    expect(xml).toContain('<key>StartInterval</key>')
    expect(xml).toContain('<integer>3600</integer>')
  })

  it('emits StartCalendarInterval for a calendar schedule', () => {
    const xml = buildPlist({ ...base, restartPolicy: 'never', startCalendar: { hour: 9, minute: 30 } })
    expect(xml).toContain('<key>StartCalendarInterval</key>')
    expect(xml).toContain('<key>Hour</key>')
    expect(xml).toContain('<integer>9</integer>')
    expect(xml).toContain('<key>Minute</key>')
    expect(xml).toContain('<integer>30</integer>')
  })
})
