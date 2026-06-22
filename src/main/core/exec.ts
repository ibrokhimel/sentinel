import { spawn, type SpawnOptions } from 'node:child_process'

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface ExecOptions extends SpawnOptions {
  /** Streamed combined output, line-ish chunks as they arrive. */
  onData?: (chunk: string) => void
  /** Reject (vs resolve) when the exit code is non-zero. Default false. */
  rejectOnNonZero?: boolean
}

/**
 * Promise wrapper around child_process.spawn. Captures stdout/stderr and
 * optionally streams them. Never uses a shell unless the caller passes one,
 * so arguments are not subject to shell injection.
 */
export function exec(
  command: string,
  args: string[] = [],
  options: ExecOptions = {}
): Promise<ExecResult> {
  const { onData, rejectOnNonZero = false, ...spawnOpts } = options
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...spawnOpts })
    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (b: Buffer) => {
      const s = b.toString()
      stdout += s
      onData?.(s)
    })
    child.stderr?.on('data', (b: Buffer) => {
      const s = b.toString()
      stderr += s
      onData?.(s)
    })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (rejectOnNonZero && code !== 0) {
        reject(new Error(`${command} exited with code ${code}\n${stderr || stdout}`))
        return
      }
      resolvePromise({ code, stdout, stderr })
    })
  })
}

/** Run a command and return trimmed stdout, throwing on failure. */
export async function execOut(
  command: string,
  args: string[] = [],
  options: ExecOptions = {}
): Promise<string> {
  const r = await exec(command, args, { ...options, rejectOnNonZero: true })
  return r.stdout.trim()
}
