import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PackageManager } from '@shared/types'
import { exec } from './exec'

type Log = (s: string) => void

/** Absolute path to the interpreter inside a bot's project venv. */
export function interpreterPath(dir: string): string {
  return join(dir, '.venv', 'bin', 'python')
}

export function venvReady(dir: string): boolean {
  return existsSync(interpreterPath(dir))
}

/** Locate a tool on PATH (or common install dirs) for clearer errors. */
async function which(tool: string): Promise<string | null> {
  const r = await exec('/bin/sh', ['-lc', `command -v ${tool} || true`])
  const path = r.stdout.trim()
  if (path) return path
  for (const c of [`${process.env.HOME}/.local/bin/${tool}`, `/opt/homebrew/bin/${tool}`, `/usr/local/bin/${tool}`]) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * Create the virtualenv and install dependencies for a bot, using the detected
 * package manager. Streams all output via `log`. Resolves to the interpreter's
 * path-relative location (always ".venv/bin/python") on success.
 */
export async function setupEnv(
  dir: string,
  pm: PackageManager,
  log: Log
): Promise<{ python: string }> {
  log(`\n=== Setting up environment (${pm}) in ${dir} ===\n`)

  switch (pm) {
    case 'uv':
      await runUv(dir, log)
      break
    case 'poetry':
      await runPoetry(dir, log)
      break
    case 'pipenv':
      await runPipenv(dir, log)
      break
    case 'existing':
    case 'venv':
    default:
      await runVenvPip(dir, log)
      break
  }

  if (!venvReady(dir)) {
    throw new Error(
      'Setup finished but .venv/bin/python is missing. Check the log above and the bot’s entry/requirements.'
    )
  }
  log('\n=== Environment ready: .venv/bin/python ===\n')
  return { python: '.venv/bin/python' }
}

async function runVenvPip(dir: string, log: Log): Promise<void> {
  const python = (await which('python3')) ?? 'python3'
  await run(python, ['-m', 'venv', '.venv'], dir, log)
  const venvPy = interpreterPath(dir)
  // Best-effort pip upgrade; don't fail setup if offline.
  await run(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip'], dir, log).catch((e) =>
    log(`(pip upgrade skipped: ${(e as Error).message})\n`)
  )
  if (existsSync(join(dir, 'requirements.txt'))) {
    await run(venvPy, ['-m', 'pip', 'install', '-r', 'requirements.txt'], dir, log)
  } else if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'setup.py'))) {
    await run(venvPy, ['-m', 'pip', 'install', '.'], dir, log)
  } else {
    log('No requirements.txt / pyproject.toml / setup.py found — created an empty venv.\n')
  }
}

async function runUv(dir: string, log: Log): Promise<void> {
  const uv = await which('uv')
  if (!uv) throw new Error('uv is not installed. Install it (https://docs.astral.sh/uv/) or change the package manager.')
  await run(uv, ['venv'], dir, log)
  if (existsSync(join(dir, 'uv.lock')) || existsSync(join(dir, 'pyproject.toml'))) {
    await run(uv, ['sync'], dir, log)
  } else if (existsSync(join(dir, 'requirements.txt'))) {
    await run(uv, ['pip', 'install', '-r', 'requirements.txt'], dir, log)
  }
}

async function runPoetry(dir: string, log: Log): Promise<void> {
  const poetry = await which('poetry')
  if (!poetry) throw new Error('poetry is not installed. Install it (https://python-poetry.org/) or change the package manager.')
  // Force the venv into the project so the interpreter is at .venv/bin/python.
  await run(poetry, ['config', 'virtualenvs.in-project', 'true', '--local'], dir, log)
  await run(poetry, ['install'], dir, log)
}

async function runPipenv(dir: string, log: Log): Promise<void> {
  const pipenv = await which('pipenv')
  if (!pipenv) throw new Error('pipenv is not installed. Install it or change the package manager.')
  // PIPENV_VENV_IN_PROJECT puts the venv at .venv/ in the project.
  await run(pipenv, ['install'], dir, log, { PIPENV_VENV_IN_PROJECT: '1' })
}

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  log: Log,
  extraEnv: Record<string, string> = {}
): Promise<void> {
  log(`$ ${cmd} ${args.join(' ')}\n`)
  const res = await exec(cmd, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    onData: log
  })
  if (res.code !== 0) {
    throw new Error(`Command failed (code ${res.code}): ${cmd} ${args.join(' ')}`)
  }
}
