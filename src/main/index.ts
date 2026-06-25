import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, powerMonitor } from 'electron'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { CH, type SystemInfo, type StartLoginResult } from '@shared/ipc'
import type { StreamChunk, BotManifest } from '@shared/types'
import { ensureDirs, botLogPaths } from './core/paths'
import * as sup from './core/supervisor'
import { findEntry, readManifest } from './core/registry'
import { botDir } from './core/paths'
import { LoginSession, PtyUnavailableError, terminalCommand } from './core/login'
import { LogTail } from './core/logtail'
import { exec } from './core/exec'
import { MonitorService } from './core/monitor'
import {
  getAgentConfig,
  getAppConfig,
  getControlConfig,
  getNotifyConfig,
  setAgentConfig,
  setAutoUpdateEnabled,
  setBackgroundAgentFlag,
  setControlEnabled,
  setGithubToken,
  setNotifyConfig
} from './core/config'
import { ping } from './core/agent/provider'
import { notifyOwner, sendTelegram } from './core/notify'
import { migrateBotsOutOfDocuments } from './core/migrate'
import {
  installMonitorAgent,
  monitorAgentInstalled,
  restartMonitorAgent,
  uninstallMonitorAgent
} from './core/agentctl'
import { TelegramControlBot } from './core/telegramBot'
import { MiniAppService } from './core/miniapp/service'

/** True when launched as the headless background monitor (`--agent`). */
const AGENT_MODE = process.argv.includes('--agent') || process.env.SENTINEL_AGENT === '1'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let monitor: MonitorService | null = null
let control: TelegramControlBot | null = null
// The in-process Telegram Mini App (Sentinel dashboard). Lives with the control
// bot: started/stopped wherever `control` is, so it shares its one-process rule.
const miniapp = new MiniAppService()
const loginSessions = new Map<string, LoginSession>()
const logTails = new Map<string, { stop(): void }>()

function send(channel: string, payload?: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

function stream(botId: string, channel: StreamChunk['channel'], data: string): void {
  send(CH.evtStream, { botId, channel, data } satisfies StreamChunk)
}

/** Tell the renderer to refresh, and update the tray. */
function botsChanged(): void {
  send(CH.evtBotsChanged)
  void refreshTray()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: 'Sentinel',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  ensureDirs()

  // One-time: relocate bots out of ~/Documents (macOS TCC blocks launchd python there).
  const moved = await migrateBotsOutOfDocuments().catch(() => [] as string[])
  if (moved.length) {
    void notifyOwner(
      `Moved ${moved.length} bot(s) out of ~/Documents to fix a macOS permission block: ${moved.join(', ')}. ` +
        `Re-run /setup for each (rebuilds its environment), then Start.`
    )
  }

  if (AGENT_MODE) {
    // Headless: no window, no dock — just supervise forever and serve Telegram.
    app.dock?.hide()
    setupPowerMonitor()
    monitor = new MonitorService({ intervalMs: 30_000 })
    monitor.start()
    control = new TelegramControlBot(() => getControlConfig(), undefined, restartSelf, () => miniapp.republish())
    control.start()
    miniapp.start()
    return
  }

  registerIpc()
  createWindow()
  setupTray()
  setupPowerMonitor()

  // In the GUI, run supervision in-process unless the always-on agent owns it
  // (avoid double crash-notifications and a duplicate Telegram poller → 409).
  control = new TelegramControlBot(() => getControlConfig(), () => botsChanged(), restartSelf, () => miniapp.republish())
  if (!monitorAgentInstalled()) {
    monitor = new MonitorService({ intervalMs: 30_000, onChange: () => botsChanged() })
    monitor.start()
    control.start()
    miniapp.start()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // In agent mode there are no windows; stay alive. Otherwise quit — bots keep
  // running via launchd regardless of the app.
  if (!AGENT_MODE) app.quit()
})

// ---------------------------------------------------------------------------
// Power-state notifications (sleep / wake)
// ---------------------------------------------------------------------------

function setupPowerMonitor(): void {
  // `powerMonitor` is only available after the app is ready.
  powerMonitor.on('suspend', () => {
    void notifyOwner('Mac is going to sleep 💤')
  })
  powerMonitor.on('resume', () => {
    void notifyOwner('Mac woke up ☀️')
  })
}

// ---------------------------------------------------------------------------
// Menu-bar tray
// ---------------------------------------------------------------------------

const TRANSPARENT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function setupTray(): void {
  try {
    const img = nativeImage.createFromDataURL(`data:image/png;base64,${TRANSPARENT_PNG}`)
    tray = new Tray(img)
    tray.setToolTip('Sentinel')
    void refreshTray()
  } catch {
    tray = null
  }
}

async function refreshTray(): Promise<void> {
  if (!tray) return
  let bots: Awaited<ReturnType<typeof sup.listBots>> = []
  try {
    bots = await sup.listBots()
  } catch {
    /* ignore */
  }
  const running = bots.filter((b) => b.runtime.status === 'running').length
  const bad = bots.filter((b) => b.runtime.status === 'crashed' || b.runtime.status === 'crash-looping').length
  tray.setTitle(`🛰 ${running}/${bots.length}${bad ? ` ⚠${bad}` : ''}`)

  const items: Electron.MenuItemConstructorOptions[] = [
    { label: `Sentinel — ${running}/${bots.length} running`, enabled: false },
    { type: 'separator' }
  ]
  for (const b of bots.slice(0, 12)) {
    items.push({
      label: `${dotFor(b.runtime.status)}  ${b.manifest.name}`,
      submenu: [
        { label: 'Start / Reload', click: () => void sup.start(b.manifest.id).then(refreshTray).catch(() => {}) },
        { label: 'Stop', click: () => void sup.stop(b.manifest.id).then(refreshTray).catch(() => {}) },
        { label: 'Restart', click: () => void sup.restart(b.manifest.id).then(refreshTray).catch(() => {}) }
      ]
    })
  }
  items.push(
    { type: 'separator' },
    { label: 'Open Sentinel', click: () => showWindow() },
    { label: 'Quit', click: () => app.quit() }
  )
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

function dotFor(status: string): string {
  if (status === 'running') return '🟢'
  if (status === 'crashed' || status === 'crash-looping') return '🔴'
  if (status === 'scheduled') return '🟡'
  return '⚪️'
}

function showWindow(): void {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
}

/** argv that launches Sentinel headless for the background agent. */
function agentProgramArgs(): string[] {
  return app.isPackaged
    ? [process.execPath, '--agent']
    : [process.execPath, app.getAppPath(), '--agent']
}

/**
 * Relaunch this process so freshly-built code loads (used by the bot's /apply).
 * In agent mode launchd's KeepAlive respawns us after exit; in the GUI we
 * explicitly relaunch first.
 */
function restartSelf(): void {
  if (!AGENT_MODE) app.relaunch()
  app.exit(0)
}

// ---------------------------------------------------------------------------

function registerIpc(): void {
  const handle = <T extends unknown[], R>(channel: string, fn: (...args: T) => Promise<R> | R): void => {
    ipcMain.handle(channel, (_e, ...args) => fn(...(args as T)))
  }

  handle(CH.listBots, () => sup.listBots())
  handle(CH.getBot, (id: string) => sup.getBot(id))

  handle(CH.importBot, async (req: Parameters<typeof sup.importBot>[0]) => {
    const result = await sup.importBot(req, (s) => stream('', 'setup', s))
    botsChanged()
    return result
  })

  handle(CH.pickFolder, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  handle(CH.updateManifest, async (id: string, patch: Partial<BotManifest>) => {
    const bot = await sup.updateManifest(id, patch)
    botsChanged()
    return bot
  })

  handle(CH.getEnv, (id: string) => sup.getEnv(id))
  handle(CH.saveEnv, async (id: string, values: Record<string, string>) => {
    await sup.saveEnv(id, values)
    botsChanged()
  })

  handle(CH.setupEnv, async (id: string) => {
    const bot = await sup.setupBotEnv(id, (s) => stream(id, 'setup', s))
    botsChanged()
    return bot
  })

  handle(CH.start, async (id: string) => {
    const bot = await sup.start(id)
    botsChanged()
    return bot
  })
  handle(CH.stop, async (id: string) => {
    const bot = await sup.stop(id)
    botsChanged()
    return bot
  })
  handle(CH.restart, async (id: string) => {
    const bot = await sup.restart(id)
    botsChanged()
    return bot
  })
  handle(CH.setAutostart, async (id: string, on: boolean) => {
    const bot = await sup.setAutostart(id, on)
    botsChanged()
    return bot
  })
  handle(CH.removeBot, async (id: string) => {
    stopLogin(id)
    stopTail(id)
    await sup.removeBot(id)
    botsChanged()
  })
  handle(CH.updateBot, async (id: string) => {
    const bot = await sup.updateBot(id, (s) => stream(id, 'setup', s))
    botsChanged()
    return bot
  })

  // ---- interactive login ----
  handle(CH.startLogin, (id: string): StartLoginResult => beginPty(id))
  // A test run is the same mechanism: run the bot in the foreground pty.
  handle(CH.startTestRun, (id: string): StartLoginResult => beginPty(id))

  ipcMain.on(CH.loginInput, (_e, id: string, data: string) => {
    loginSessions.get(id)?.write(data)
  })
  ipcMain.on(CH.stopLogin, (_e, id: string) => stopLogin(id))

  handle(CH.openInTerminal, async (id: string) => {
    const entry = findEntry(id)
    if (!entry) throw new Error(`Unknown bot: ${id}`)
    const dir = botDir(entry.dirName)
    const manifest = readManifest(dir)
    if (!manifest) throw new Error(`Bot ${id} has no manifest`)
    const cmd = terminalCommand(manifest, dir)
    await openInTerminalApp(cmd)
  })

  // ---- log tail ----
  handle(CH.startLogTail, (id: string) => {
    stopTail(id)
    const { out, err } = botLogPaths(id)
    const tOut = new LogTail(out, (d) => stream(id, 'log', d))
    const tErr = new LogTail(err, (d) => stream(id, 'log', d))
    tOut.start()
    tErr.start()
    // Track both under one logical handle.
    logTails.set(id, {
      stop() {
        tOut.stop()
        tErr.stop()
      }
    })
  })
  ipcMain.on(CH.stopLogTail, (_e, id: string) => stopTail(id))

  // ---- updates ----
  handle(CH.checkUpdates, (id: string) => sup.checkUpdates(id))
  handle(CH.pushLive, (id: string) => sup.pushLive(id, (s) => stream(id, 'setup', s)))

  // ---- config / preferences ----
  handle(CH.getConfig, () => getAppConfig())
  handle(CH.setNotify, (patch: { enabled?: boolean; chatId?: string; token?: string }) => {
    setNotifyConfig(patch)
    return getAppConfig()
  })
  handle(CH.testNotify, async () => {
    const c = getNotifyConfig()
    if (!c.token || !c.chatId) return false
    return sendTelegram(c.token, c.chatId, '🛰️ Sentinel test notification — you are all set.')
  })
  handle(CH.setAutoUpdate, (on: boolean) => {
    setAutoUpdateEnabled(on)
    return getAppConfig()
  })
  handle(CH.setBackgroundAgent, async (on: boolean) => {
    if (on) {
      await installMonitorAgent(agentProgramArgs())
      setBackgroundAgentFlag(true)
      // The agent owns supervision now; stop the in-app monitor + poller to avoid
      // dupes (two getUpdates pollers on one token → Telegram 409).
      monitor?.stop()
      monitor = null
      control?.stop()
      miniapp.stop()
    } else {
      await uninstallMonitorAgent()
      setBackgroundAgentFlag(false)
      if (!monitor) {
        monitor = new MonitorService({ intervalMs: 30_000, onChange: () => botsChanged() })
        monitor.start()
      }
      control?.start() // resume in-GUI control if it's enabled
      miniapp.refresh()
    }
    return getAppConfig()
  })
  handle(CH.setControl, async (on: boolean) => {
    setControlEnabled(on)
    if (monitorAgentInstalled()) {
      // The headless agent owns the poller; bounce it so it re-reads config.
      await restartMonitorAgent().catch(() => undefined)
    } else if (on) {
      control?.start()
      miniapp.start()
    } else {
      control?.stop()
      miniapp.stop()
    }
    return getAppConfig()
  })
  handle(CH.setAgent, (patch: { baseUrl?: string; model?: string; key?: string }) => {
    setAgentConfig(patch)
    return getAppConfig()
  })
  handle(CH.setGithubToken, (token: string) => {
    setGithubToken(token)
    return getAppConfig()
  })
  handle(CH.testAgent, async () => {
    const a = getAgentConfig()
    if (!a.ready) return false
    return ping({ baseUrl: a.baseUrl, apiKey: a.apiKey, model: a.model })
  })

  // ---- system ----
  handle(CH.systemInfo, () => systemInfo())
  handle(CH.setAppAutoLaunch, (on: boolean) => {
    app.setLoginItemSettings({ openAtLogin: on })
  })
  handle(CH.openAutoLoginSettings, async () => {
    await shell.openExternal('x-apple.systempreferences:com.apple.Users-Groups-Settings.extension')
  })
  handle(CH.revealBotDir, (id: string) => {
    const entry = findEntry(id)
    if (entry) shell.openPath(botDir(entry.dirName))
  })
}

/** Start the bot's entry in a pty (shared by login + test-run). */
function beginPty(id: string): StartLoginResult {
  const entry = findEntry(id)
  if (!entry) throw new Error(`Unknown bot: ${id}`)
  const dir = botDir(entry.dirName)
  const manifest = readManifest(dir)
  if (!manifest) throw new Error(`Bot ${id} has no manifest`)

  stopLogin(id)
  const session = new LoginSession(manifest, dir)
  try {
    session.start(
      (data) => stream(id, 'login', data),
      (code) => {
        loginSessions.delete(id)
        send(CH.evtLoginExit, { botId: id, code })
      }
    )
    loginSessions.set(id, session)
    return { mode: 'pty' }
  } catch (err) {
    if (err instanceof PtyUnavailableError) {
      return { mode: 'terminal', command: terminalCommand(manifest, dir), reason: err.message }
    }
    throw err
  }
}

function stopLogin(id: string): void {
  loginSessions.get(id)?.stop()
  loginSessions.delete(id)
}
function stopTail(id: string): void {
  logTails.get(id)?.stop()
  logTails.delete(id)
}

async function systemInfo(): Promise<SystemInfo> {
  const macVersion = await safe(() => execOut1('sw_vers', ['-productVersion']), 'unknown')
  const fvRaw = await safe(() => execOut1('fdesetup', ['status']), '')
  const fileVaultOn = fvRaw ? /On/i.test(fvRaw) && !/Off/i.test(fvRaw) : null
  const autoLoginUser =
    (await safe(
      () => execOut1('defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser']),
      ''
    )) || null
  return {
    macVersion,
    fileVaultOn,
    autoLoginUser,
    appAutoLaunch: app.getLoginItemSettings().openAtLogin,
    currentUser: userInfo().username,
    backgroundAgent: monitorAgentInstalled()
  }
}

async function execOut1(cmd: string, args: string[]): Promise<string> {
  const r = await exec(cmd, args)
  return r.stdout.trim()
}
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

async function openInTerminalApp(command: string): Promise<void> {
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  await exec('osascript', [
    '-e',
    `tell application "Terminal" to do script "${escaped}"`,
    '-e',
    'tell application "Terminal" to activate'
  ])
}
