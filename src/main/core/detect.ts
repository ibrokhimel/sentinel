import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  DetectResult,
  Framework,
  MiniAppDetect,
  PackageManager,
  WebFramework
} from '@shared/types'
import { parseEnvKeys } from './env'

/**
 * Inspect an imported project and guess how to set it up and run it. A
 * `package.json` routes to Node detection (web apps / Mini Apps + Node bots);
 * everything else is treated as a Python project. Result is a best guess — the
 * user can edit any field in the manifest.
 */
export function detect(dir: string): DetectResult {
  if (existsSync(join(dir, 'package.json'))) return detectNode(dir)
  return detectPython(dir)
}

/** Inspect a Python project directory and guess how to set it up and run it. */
function detectPython(dir: string): DetectResult {
  const notes: string[] = []
  const has = (f: string) => existsSync(join(dir, f))
  const read = (f: string): string => {
    try {
      return readFileSync(join(dir, f), 'utf8')
    } catch {
      return ''
    }
  }

  const pyproject = has('pyproject.toml') ? read('pyproject.toml') : ''

  // ---- package manager ----
  let packageManager: PackageManager
  if (existsSync(join(dir, '.venv', 'bin', 'python'))) {
    packageManager = 'existing'
    notes.push('Found an existing .venv — Sentinel will recreate it cleanly on setup.')
  } else if (has('uv.lock') || /\[tool\.uv\]/.test(pyproject)) {
    packageManager = 'uv'
  } else if (has('poetry.lock') || /\[tool\.poetry\]/.test(pyproject) || /poetry[._-]core/.test(pyproject)) {
    packageManager = 'poetry'
  } else if (has('Pipfile')) {
    packageManager = 'pipenv'
  } else {
    packageManager = 'venv'
  }
  notes.push(`Package manager: ${packageManager}.`)

  // ---- entry point ----
  const { entry, entryNote } = detectEntry(dir, pyproject)
  notes.push(entryNote)

  // ---- env keys ----
  let envKeys: string[] = []
  if (has('.env.example')) {
    envKeys = parseEnvKeys(read('.env.example'))
    notes.push(`Found .env.example with ${envKeys.length} key(s).`)
  } else if (has('.env.sample')) {
    envKeys = parseEnvKeys(read('.env.sample'))
    notes.push(`Found .env.sample with ${envKeys.length} key(s).`)
  } else {
    notes.push('No .env.example found — add env keys manually if the bot needs them.')
  }

  // ---- framework ----
  const framework = detectFramework(read)
  if (framework !== 'unknown') notes.push(`Framework: ${framework}.`)

  const confidence: 'high' | 'low' = entry.length > 0 ? 'high' : 'low'

  return {
    runtime: 'python',
    packageManager,
    python: '.venv/bin/python',
    entry,
    envKeys,
    framework,
    confidence,
    notes
  }
}

// ---- Node detection --------------------------------------------------------

/** package.json scripts a web server might be started with, best first.
 * `dev` is preferred over `preview` so the app serves without a separate build. */
const WEB_SCRIPTS = ['start', 'dev', 'serve', 'preview']
/** Default dev/preview port per framework. */
const FRAMEWORK_PORT: Record<WebFramework, number> = {
  vite: 5173,
  next: 3000,
  cra: 3000,
  astro: 4321,
  node: 3000,
  unknown: 3000
}

interface PackageJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  main?: string
}

/**
 * Inspect a Node project. Distinguishes a **web app / Mini App** (Vite, Next,
 * CRA, Astro, or a plain HTTP server) — which gets the tunnel + menu-button
 * runtime — from a plain **Node bot** (telegraf/grammy/etc.), which just runs
 * like a Python bot.
 */
function detectNode(dir: string): DetectResult {
  const notes: string[] = []
  const has = (f: string) => existsSync(join(dir, f))
  const read = (f: string): string => {
    try {
      return readFileSync(join(dir, f), 'utf8')
    } catch {
      return ''
    }
  }

  let pkg: PackageJson = {}
  try {
    pkg = JSON.parse(read('package.json')) as PackageJson
  } catch {
    notes.push('package.json could not be parsed — using defaults.')
  }
  const scripts = pkg.scripts ?? {}
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const depNames = Object.keys(deps)

  // ---- package manager (from lockfile) ----
  let packageManager: PackageManager
  if (has('pnpm-lock.yaml')) packageManager = 'pnpm'
  else if (has('yarn.lock')) packageManager = 'yarn'
  else if (has('bun.lockb') || has('bun.lock')) packageManager = 'bun'
  else packageManager = 'npm'
  notes.push(`Node project · package manager: ${packageManager}.`)

  // ---- web framework ----
  const webFramework = detectWebFramework(depNames, scripts)
  const isWebApp =
    webFramework !== 'unknown' ||
    // Plain HTTP server libs with a start-ish script also count as a web app.
    (depNames.some((d) => /^(express|fastify|koa|hapi|@hapi\/hapi|h3|hono|polka)$/.test(d)) &&
      WEB_SCRIPTS.some((s) => scripts[s]))

  // ---- run script / entry ----
  const script = WEB_SCRIPTS.find((s) => scripts[s]) ?? Object.keys(scripts)[0] ?? ''
  let entry: string[] = []
  let miniApp: MiniAppDetect | undefined

  if (isWebApp && script) {
    entry = ['__miniapp__']
    const fw: WebFramework = webFramework === 'unknown' ? 'node' : webFramework
    miniApp = { script, port: FRAMEWORK_PORT[fw], webFramework: fw }
    notes.push(`Mini App candidate (${fw}) — runs "${script}", default port ${miniApp.port}.`)
    notes.push('Will expose over HTTPS via cloudflared and register a Telegram menu button.')
  } else if (script) {
    entry = [`__npm__:${script}`]
    notes.push(`Node bot — runs "${packageManager} run ${script}".`)
  } else if (pkg.main) {
    entry = ['__nodefile__', pkg.main]
    notes.push(`Node bot — runs "node ${pkg.main}".`)
  } else if (has('index.js') || has('server.js') || has('app.js')) {
    const file = ['server.js', 'app.js', 'index.js'].find((f) => has(f))!
    entry = ['__nodefile__', file]
    notes.push(`Node bot — runs "node ${file}".`)
  } else {
    notes.push('Could not determine how to start this Node project — set it manually.')
  }

  // ---- env keys ----
  let envKeys: string[] = []
  if (has('.env.example')) {
    envKeys = parseEnvKeys(read('.env.example'))
    notes.push(`Found .env.example with ${envKeys.length} key(s).`)
  } else if (has('.env.sample')) {
    envKeys = parseEnvKeys(read('.env.sample'))
    notes.push(`Found .env.sample with ${envKeys.length} key(s).`)
  } else if (miniApp) {
    notes.push('No .env.example — add TELEGRAM_BOT_TOKEN to register the menu button.')
  }

  return {
    runtime: 'node',
    packageManager,
    python: '',
    entry,
    envKeys,
    framework: 'unknown',
    confidence: entry.length > 0 ? 'high' : 'low',
    notes,
    miniApp
  }
}

function detectWebFramework(depNames: string[], scripts: Record<string, string>): WebFramework {
  const has = (re: RegExp) => depNames.some((d) => re.test(d))
  const scriptBlob = Object.values(scripts).join(' ').toLowerCase()
  if (has(/^next$/) || /\bnext\b/.test(scriptBlob)) return 'next'
  if (has(/^astro$/) || /\bastro\b/.test(scriptBlob)) return 'astro'
  if (has(/^vite$/) || /\bvite\b/.test(scriptBlob)) return 'vite'
  if (has(/^react-scripts$/) || /\breact-scripts\b/.test(scriptBlob)) return 'cra'
  return 'unknown'
}

/**
 * Guess the Telegram framework from dependency declarations and imports. This
 * drives whether a one-time phone-code `.session` login is needed (Telethon /
 * Pyrogram user sessions) vs a plain Bot API token (aiogram / PTB).
 */
function detectFramework(read: (f: string) => string): Framework {
  const haystack = [
    read('requirements.txt'),
    read('pyproject.toml'),
    read('Pipfile'),
    read('uv.lock'),
    read('poetry.lock')
  ]
    .join('\n')
    .toLowerCase()

  // Also scan a couple of likely source files for imports.
  let src = ''
  for (const f of ['main.py', 'bot.py', 'run.py', 'app.py']) {
    src += read(f).toLowerCase()
  }
  const blob = haystack + '\n' + src

  if (/telethon/.test(blob)) return 'telethon'
  if (/pyrogram/.test(blob)) return 'pyrogram'
  if (/aiogram/.test(blob)) return 'aiogram'
  if (/python[-_]telegram[-_]bot|import telegram\b|from telegram\b/.test(blob)) return 'bot-api'
  return 'unknown'
}

const ENTRY_CONVENTIONS = ['main.py', 'bot.py', 'app.py', 'run.py', '__main__.py']

function detectEntry(dir: string, pyproject: string): { entry: string[]; entryNote: string } {
  // 1. Procfile worker/web line is authoritative.
  const procfile = join(dir, 'Procfile')
  if (existsSync(procfile)) {
    try {
      const text = readFileSync(procfile, 'utf8')
      const line = text.split('\n').find((l) => /^(worker|web|bot)\s*:/.test(l.trim()))
      if (line) {
        const cmd = line.slice(line.indexOf(':') + 1).trim()
        // Strip a leading interpreter token if present; keep the rest as args.
        const tokens = cmd.split(/\s+/)
        const stripped = /^python(3(\.\d+)?)?$/.test(tokens[0]) ? tokens.slice(1) : tokens
        if (stripped.length) return { entry: stripped, entryNote: `Entry from Procfile: ${cmd}` }
      }
    } catch {
      /* ignore */
    }
  }

  // 2. console_scripts / [project.scripts] -> run the installed script from the venv.
  const scriptMatch = pyproject.match(/\[project\.scripts\]\s*\n([^[]*)/)
  if (scriptMatch) {
    const first = scriptMatch[1].split('\n').map((l) => l.trim()).find((l) => l && l.includes('='))
    if (first) {
      const scriptName = first.split('=')[0].trim()
      if (scriptName) {
        return {
          entry: [`__script__:${scriptName}`],
          entryNote: `Entry from [project.scripts]: ${scriptName} (runs .venv/bin/${scriptName}).`
        }
      }
    }
  }

  // 3. Convention files at the repo root.
  for (const f of ENTRY_CONVENTIONS) {
    if (existsSync(join(dir, f))) {
      return { entry: [f], entryNote: `Entry guessed from convention file: ${f}.` }
    }
  }

  // 4. A package directory containing __main__.py -> python -m <pkg>.
  try {
    for (const name of readdirSync(dir)) {
      const sub = join(dir, name)
      if (name.startsWith('.') || name === 'tests') continue
      if (statSync(sub).isDirectory() && existsSync(join(sub, '__main__.py'))) {
        return { entry: ['-m', name], entryNote: `Entry from package with __main__.py: python -m ${name}.` }
      }
    }
  } catch {
    /* ignore */
  }

  return { entry: [], entryNote: 'Could not auto-detect an entry point — set it manually.' }
}
