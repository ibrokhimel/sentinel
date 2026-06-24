// Domain types shared across the main process, preload, and renderer.

export type PackageManager =
  // python
  | 'venv'
  | 'uv'
  | 'poetry'
  | 'pipenv'
  | 'existing'
  // node
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
export type RestartPolicy = 'always' | 'on-crash' | 'never'

/** Which interpreter family a bot runs under. Absent in old manifests = 'python'. */
export type Runtime = 'python' | 'node'

/** Web frameworks Sentinel recognises for Mini Apps (drives port flags). */
export type WebFramework = 'vite' | 'next' | 'cra' | 'astro' | 'node' | 'unknown'

/**
 * Telegram Mini App runtime config. A Mini App is a Node web server that
 * Sentinel keeps alive AND exposes over HTTPS (via a tunnel) so Telegram can
 * load it, optionally registering it as the bot's chat menu button.
 */
export interface MiniAppConfig {
  enabled: boolean
  /** npm/pnpm/yarn/bun script that starts the web server (e.g. "dev", "preview"). */
  script: string
  /** Local port the web server listens on (and that the tunnel points at). */
  port: number
  /** How the app is exposed over HTTPS for Telegram. */
  tunnel: 'cloudflared' | 'none'
  /** Detected web framework — drives how the port flag is passed. */
  webFramework: WebFramework
  /** When tunnel === 'none', the fixed public HTTPS URL to register. */
  publicUrl?: string
  /** Register the bot's chat menu button to open the Mini App on (re)start. */
  setMenuButton: boolean
  /** Menu button label shown in Telegram. */
  menuText: string
}
export type BotStatus =
  | 'running'
  | 'stopped'
  | 'crashed'
  | 'crash-looping'
  | 'scheduled'
  | 'starting'
  | 'not-installed'
  | 'unknown'

/** Detected Telegram framework — drives whether a one-time .session login is needed. */
export type Framework = 'telethon' | 'aiogram' | 'pyrogram' | 'bot-api' | 'unknown'

/** Optional run schedule (for bots that should run at times, not always). */
export interface Schedule {
  kind: 'interval' | 'calendar'
  /** for kind 'interval': seconds between launches. */
  intervalSeconds?: number
  /** for kind 'calendar': run at this time (any omitted field = wildcard). */
  calendar?: { hour?: number; minute?: number; weekday?: number }
}

/** How a bot was brought into Sentinel. */
export interface BotSource {
  type: 'git' | 'local'
  /** Original local path or git URL. */
  origin: string
  branch?: string
}

/**
 * Per-bot manifest, persisted at `bots/<dir>/sentinel.json`.
 * Single source of truth for how to launch the bot. Never rewrites the bot's
 * own source — only describes it.
 */
export interface BotManifest {
  id: string
  name: string
  source: BotSource
  /** Interpreter family. Absent = 'python' (back-compat with pre-Node manifests). */
  runtime?: Runtime
  packageManager: PackageManager
  /** Interpreter relative to the bot dir, e.g. ".venv/bin/python". Empty for Node. */
  python: string
  /** Arguments after the interpreter, e.g. ["run_watcher.py", "--verbose"]. */
  entry: string[]
  /** Env file the bot reads (written by Sentinel), e.g. ".env". */
  envFile: string
  /** Keys discovered from .env.example (names only, never values). */
  envKeys: string[]
  restartPolicy: RestartPolicy
  /** App-level crash-loop cutoff (launchd itself never gives up). */
  maxRestarts: number
  /** Whether the launchd agent has RunAtLoad (starts on login/boot). */
  autostart: boolean
  createdAt: string

  // ---- optional (added post-v1; default in code when absent) ----
  /** Detected Telegram framework. */
  framework?: Framework
  /** Auto-pull from GitHub on a schedule (git-sourced bots only). */
  autoUpdate?: boolean
  /** Hours between auto-update checks. */
  updateIntervalHours?: number
  /** Last known-good commit SHA (for rollback after a bad update). */
  lastGoodSha?: string
  /** If set, run on a schedule instead of always-on (StartCalendarInterval/StartInterval). */
  schedule?: Schedule
  /** Free-form tags for grouping/search. */
  tags?: string[]
  /** Notify on crash/crash-loop for this bot (default true). */
  notifyOnCrash?: boolean
  /** Telegram Mini App config (Node web-server bots). Absent = not a Mini App. */
  miniApp?: MiniAppConfig
}

/** Live runtime state, derived from launchctl + the filesystem. */
export interface BotRuntime {
  label: string
  status: BotStatus
  pid: number | null
  lastExitCode: number | null
  restarts: number
  /** launchd agent is bootstrapped (plist installed + loaded). */
  installed: boolean
  /** venv interpreter exists on disk. */
  envReady: boolean
  /** the env file exists. */
  envFilePresent: boolean
  /** Commits behind origin (null = unknown/not git/not checked). */
  updatesBehind?: number | null
  /** CPU percent of the running process (null = not running/unknown). */
  cpu?: number | null
  /** Resident memory in MB (null = not running/unknown). */
  memMB?: number | null
  /** RSS as a percent of total system RAM. */
  memPct?: number | null
  /** Process uptime, e.g. "02:59" or "1-03:04:05". */
  uptime?: string | null
  /** Process uptime in whole seconds (numeric anchor for live UI tickers). */
  uptimeSec?: number | null
}

export interface Bot {
  manifest: BotManifest
  /** Absolute bot directory. */
  dir: string
  runtime: BotRuntime
}

/** What detection found about a Node Mini App candidate. */
export interface MiniAppDetect {
  script: string
  port: number
  webFramework: WebFramework
}

/** Result of scanning an imported project. */
export interface DetectResult {
  /** Interpreter family the project runs under. */
  runtime: Runtime
  packageManager: PackageManager
  python: string
  entry: string[]
  envKeys: string[]
  framework: Framework
  confidence: 'high' | 'low'
  notes: string[]
  /** Present when the Node project looks like a web app / Telegram Mini App. */
  miniApp?: MiniAppDetect
}

export interface ImportRequest {
  /** "git" with a URL, or "local" with an absolute folder path. */
  type: 'git' | 'local'
  source: string
  /** Optional display name; defaults to the repo/folder name. */
  name?: string
  /** Personal access token for private git repos (not persisted). */
  token?: string
  branch?: string
}

/** A streamed line of output (setup, login, or log tail). */
export interface StreamChunk {
  botId: string
  channel: 'setup' | 'login' | 'log'
  data: string
}

/** Generic result wrapper for IPC calls that can fail gracefully. */
export interface Result<T> {
  ok: boolean
  value?: T
  error?: string
}

/**
 * App-level settings persisted at ~/Documents/Sentinel/config.json.
 * The notifier token is stored encrypted (Electron safeStorage); the plaintext
 * never touches disk and is not returned to the renderer.
 */
export interface AppConfig {
  notify: {
    enabled: boolean
    /** Whether a bot token is stored (the token itself is never returned). */
    hasToken: boolean
    chatId: string
  }
  /**
   * Inbound Telegram control: when enabled, the SAME bot accepts commands
   * (status/start/stop/restart/logs/update) from the owner chat. Reuses the
   * notifier token + chatId — set those first.
   */
  control: {
    enabled: boolean
    /** True when a token + owner chat id are present so control can actually run. */
    ready: boolean
  }
  /**
   * AI agent provider (OpenAI-compatible). The API key is stored encrypted and
   * never returned to the renderer.
   */
  agent: {
    baseUrl: string
    model: string
    hasKey: boolean
    /** True when baseUrl + model + key are all present. */
    ready: boolean
  }
  /** Skip the agent's per-action approval prompts ("YOLO"/bypass mode). */
  autoApprove: boolean
  /** Global gate for scheduled auto-update (per-bot autoUpdate must also be on). */
  autoUpdateEnabled: boolean
  /** The always-on background monitor agent (com.sentinel.monitor) is installed. */
  backgroundAgent: boolean
  /** Whether a GitHub token is stored (for pushing to e.g. sentinel-live). */
  hasGithubToken: boolean
}

/** A Telegram user known to Sentinel — captured at access-request time and
 *  carried through approval so the dashboard can show names, not bare IDs. */
export interface UserProfile {
  id: number
  firstName?: string
  lastName?: string
  username?: string
  /** ms epoch of first access request. */
  requestedAt?: number
  /** ms epoch when the owner approved (undefined while pending/ignored). */
  approvedAt?: number
}

/** Result of checking a bot's git remote for new commits. */
export interface UpdateCheck {
  isGit: boolean
  behind: number
  branch: string | null
  error?: string
}
