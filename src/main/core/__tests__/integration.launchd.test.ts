import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as launchctl from '../launchctl'
import { plistPath } from '../paths'
import { setupEnv, venvReady, interpreterPath } from '../venv'
import { resolveArgv } from '../launchspec'
import type { BotManifest } from '@shared/types'

// Real integration test against this machine's launchd + python. Mutates system
// state (creates a venv and a transient LaunchAgent), so it only runs when
// explicitly enabled: SENTINEL_INTEGRATION=1 npx vitest run.
const ENABLED = process.env.SENTINEL_INTEGRATION === '1' && process.platform === 'darwin'
const maybe = ENABLED ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

maybe('launchd full lifecycle (real)', () => {
  it('sets up a venv, installs an agent, auto-restarts, and unloads cleanly', async () => {
    const id = `itest${Date.now().toString(36)}`
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-itest-'))
    // A trivial "bot": prints its pid then idles. No dependencies.
    writeFileSync(
      join(dir, 'bot.py'),
      'import os, time, sys\nprint("pid", os.getpid(), flush=True)\nwhile True:\n    time.sleep(30)\n'
    )

    const manifest: BotManifest = {
      id,
      name: 'itest',
      source: { type: 'local', origin: dir },
      packageManager: 'venv',
      python: '.venv/bin/python',
      entry: ['bot.py'],
      envFile: '.env',
      envKeys: [],
      restartPolicy: 'always',
      maxRestarts: 10,
      autostart: true,
      createdAt: new Date().toISOString()
    }

    try {
      // 1. Create the venv (no requirements -> fast).
      await setupEnv(dir, 'venv', () => {})
      expect(venvReady(dir)).toBe(true)
      expect(existsSync(interpreterPath(dir))).toBe(true)

      // 2. Install + bootstrap the agent.
      const argv = resolveArgv(manifest, dir)
      argv[0] = interpreterPath(dir)
      await launchctl.installAgent(id, {
        label: `com.sentinel.${id}`,
        programArgs: argv,
        workingDir: dir,
        stdoutPath: join(dir, 'out.log'),
        stderrPath: join(dir, 'err.log'),
        restartPolicy: 'always',
        runAtLoad: true,
        throttleInterval: 2
      })
      expect(existsSync(plistPath(id))).toBe(true)

      // 3. It should be running.
      await sleep(2000)
      const s1 = await launchctl.status(id)
      expect(s1.installed).toBe(true)
      expect(s1.running).toBe(true)
      expect(s1.pid).toBeGreaterThan(0)

      // 4. KeepAlive should restart it after a kill.
      process.kill(s1.pid!, 'SIGKILL')
      await sleep(4000)
      const s2 = await launchctl.status(id)
      expect(s2.running).toBe(true)
      expect(s2.pid).not.toBe(s1.pid)

      // 5. Bootout should fully unload (through the I/O-error retry path).
      await launchctl.bootout(id)
      await sleep(500)
      const s3 = await launchctl.status(id)
      expect(s3.running).toBe(false)
    } finally {
      await launchctl.uninstallAgent(id).catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  // Regression: a label left in launchd's "disabled" override DB used to make
  // installAgent fail with "Input/output error" (errno 5) and stranded the bot
  // down (KeepAlive/RunAtLoad are ignored while disabled). installAgent now
  // enables the label before bootstrap, so recovery must just work.
  it('recovers a service that was disabled out-of-band', async () => {
    const id = `itestd${Date.now().toString(36)}`
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-itestd-'))
    writeFileSync(
      join(dir, 'bot.py'),
      'import os, time\nprint("pid", os.getpid(), flush=True)\nwhile True:\n    time.sleep(30)\n'
    )
    const label = `com.sentinel.${id}`
    const uid = execFileSync('id', ['-u']).toString().trim()
    const cfg = {
      label,
      programArgs: ['/usr/bin/python3', join(dir, 'bot.py')],
      workingDir: dir,
      stdoutPath: join(dir, 'out.log'),
      stderrPath: join(dir, 'err.log'),
      restartPolicy: 'always' as const,
      runAtLoad: true,
      throttleInterval: 2
    }
    try {
      // Install, then disable + unload it out-of-band (mimics the failure).
      await launchctl.installAgent(id, cfg)
      execFileSync('launchctl', ['disable', `gui/${uid}/${label}`])
      await launchctl.bootout(id).catch(() => undefined)
      expect(await launchctl.isDisabled(id)).toBe(true)

      // installAgent must now succeed despite the disabled override...
      await launchctl.installAgent(id, cfg)
      await sleep(2000)
      expect(await launchctl.isDisabled(id)).toBe(false)
      const s = await launchctl.status(id)
      expect(s.running).toBe(true)
    } finally {
      await launchctl.uninstallAgent(id).catch(() => undefined)
      execFileSync('launchctl', ['enable', `gui/${uid}/${label}`], { stdio: 'ignore' })
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
