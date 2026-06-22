import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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
})
