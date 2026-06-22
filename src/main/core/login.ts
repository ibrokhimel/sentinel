import type { BotManifest } from '@shared/types'
import { resolveArgv } from './launchspec'

type DataCb = (data: string) => void
type ExitCb = (code: number | null) => void

/**
 * An interactive run of a bot in a pseudo-terminal, used for first-time
 * Telegram (Telethon) login where the bot prompts for a phone number and code
 * on stdin. A PTY is required: with plain pipes CPython block-buffers the
 * prompt and it never reaches the UI.
 *
 * If the native pty addon can't load (ABI mismatch in a packaged build, etc.),
 * `start` throws PtyUnavailableError and the caller falls back to opening the
 * command in Terminal.app — the 24/7 supervision path never depends on this.
 */
export class PtyUnavailableError extends Error {}

interface PtyProc {
  onData(cb: (d: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(d: string): void
  kill(signal?: string): void
}

function loadPty(): { spawn: (file: string, args: string[], opts: object) => PtyProc } {
  try {
    // Lazy require so the app still boots if the native module is missing.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@homebridge/node-pty-prebuilt-multiarch')
  } catch (err) {
    throw new PtyUnavailableError(
      `Embedded terminal unavailable (${(err as Error).message}). Use "Open in Terminal" instead.`
    )
  }
}

export class LoginSession {
  private proc: PtyProc | null = null

  constructor(
    private manifest: BotManifest,
    private dir: string
  ) {}

  start(onData: DataCb, onExit: ExitCb): void {
    const pty = loadPty()
    const [file, ...args] = resolveArgv(this.manifest, this.dir)
    this.proc = pty.spawn(file, args, {
      name: 'xterm-color',
      cols: 100,
      rows: 30,
      cwd: this.dir,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    })
    this.proc.onData((d) => onData(d))
    this.proc.onExit(({ exitCode }) => {
      this.proc = null
      onExit(exitCode)
    })
  }

  write(data: string): void {
    this.proc?.write(data)
  }

  stop(): void {
    try {
      this.proc?.kill()
    } catch {
      /* ignore */
    }
    this.proc = null
  }
}

/**
 * Build a shell command that runs the bot interactively from a real terminal,
 * for the "Open in Terminal" fallback. Returns a string safe to feed to
 * Terminal.app via `open` / AppleScript.
 */
export function terminalCommand(manifest: BotManifest, dir: string): string {
  const argv = resolveArgv(manifest, dir).map(shellQuote)
  return `cd ${shellQuote(dir)} && ${argv.join(' ')}`
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}
