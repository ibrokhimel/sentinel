import type {
  AppConfig,
  Bot,
  BotManifest,
  DetectResult,
  ImportRequest,
  StreamChunk,
  UpdateCheck
} from './types'

/** IPC channel names, shared by main and preload. */
export const CH = {
  listBots: 'bots:list',
  getBot: 'bots:get',
  importBot: 'bots:import',
  pickFolder: 'dialog:pickFolder',
  updateManifest: 'bots:update',
  getEnv: 'env:get',
  saveEnv: 'env:save',
  setupEnv: 'env:setup',
  start: 'bots:start',
  stop: 'bots:stop',
  restart: 'bots:restart',
  setAutostart: 'bots:setAutostart',
  removeBot: 'bots:remove',
  updateBot: 'bots:pull',
  startLogin: 'login:start',
  loginInput: 'login:input',
  stopLogin: 'login:stop',
  openInTerminal: 'login:terminal',
  startLogTail: 'log:start',
  stopLogTail: 'log:stop',
  // updates
  checkUpdates: 'bots:checkUpdates',
  pushLive: 'bots:pushLive',
  // test run (foreground pty)
  startTestRun: 'test:start',
  // config / preferences
  getConfig: 'config:get',
  setNotify: 'config:setNotify',
  testNotify: 'config:testNotify',
  setAutoUpdate: 'config:setAutoUpdate',
  setBackgroundAgent: 'config:setBackgroundAgent',
  setControl: 'config:setControl',
  setAgent: 'config:setAgent',
  testAgent: 'config:testAgent',
  setGithubToken: 'config:setGithubToken',
  // system
  systemInfo: 'system:info',
  setAppAutoLaunch: 'system:setAppAutoLaunch',
  openAutoLoginSettings: 'system:openAutoLogin',
  revealBotDir: 'system:reveal',
  // events (main -> renderer)
  evtStream: 'evt:stream',
  evtLoginExit: 'evt:loginExit',
  evtBotsChanged: 'evt:botsChanged'
} as const

export interface SystemInfo {
  macVersion: string
  fileVaultOn: boolean | null
  autoLoginUser: string | null
  appAutoLaunch: boolean
  /** This machine's login user, for the auto-login hint. */
  currentUser: string
  /** The always-on background monitor agent is installed. */
  backgroundAgent: boolean
}

export type StartLoginResult =
  | { mode: 'pty' }
  | { mode: 'terminal'; command: string; reason: string }

/** The full API surface exposed on `window.sentinel`. */
export interface SentinelAPI {
  listBots(): Promise<Bot[]>
  getBot(id: string): Promise<Bot>
  importBot(req: ImportRequest): Promise<{ bot: Bot; detect: DetectResult }>
  pickFolder(): Promise<string | null>
  updateManifest(id: string, patch: Partial<BotManifest>): Promise<Bot>

  getEnv(id: string): Promise<{ keys: string[]; example: Record<string, string>; current: Record<string, string> }>
  saveEnv(id: string, values: Record<string, string>): Promise<void>
  setupEnv(id: string): Promise<Bot>

  start(id: string): Promise<Bot>
  stop(id: string): Promise<Bot>
  restart(id: string): Promise<Bot>
  setAutostart(id: string, on: boolean): Promise<Bot>
  removeBot(id: string): Promise<void>
  updateBot(id: string): Promise<Bot>

  startLogin(id: string): Promise<StartLoginResult>
  loginInput(id: string, data: string): void
  stopLogin(id: string): void
  openInTerminal(id: string): Promise<void>

  startLogTail(id: string): Promise<void>
  stopLogTail(id: string): void

  checkUpdates(id: string): Promise<UpdateCheck>
  /** Snapshot the bot's working tree to a branch (default sentinel-live) and push it. Streams on 'setup'. */
  pushLive(id: string): Promise<{ branch: string; commit: string; url: string | null }>
  /** Run the bot once in the foreground via the login pty (test run). Streams on 'login'. */
  startTestRun(id: string): Promise<StartLoginResult>

  getConfig(): Promise<AppConfig>
  setNotify(patch: { enabled?: boolean; chatId?: string; token?: string }): Promise<AppConfig>
  testNotify(): Promise<boolean>
  setAutoUpdate(on: boolean): Promise<AppConfig>
  setBackgroundAgent(on: boolean): Promise<AppConfig>
  /** Enable/disable the inbound Telegram control bot (commands from your chat). */
  setControl(on: boolean): Promise<AppConfig>
  /** Set AI provider fields. key: undefined keep · '' clear · else store encrypted. */
  setAgent(patch: { baseUrl?: string; model?: string; key?: string }): Promise<AppConfig>
  /** Validate the AI provider with a tiny completion. */
  testAgent(): Promise<boolean>
  /** Store/clear the GitHub token (for pushing to sentinel-live). '' clears. */
  setGithubToken(token: string): Promise<AppConfig>

  getSystemInfo(): Promise<SystemInfo>
  setAppAutoLaunch(on: boolean): Promise<void>
  openAutoLoginSettings(): Promise<void>
  revealBotDir(id: string): Promise<void>

  onStream(cb: (chunk: StreamChunk) => void): () => void
  onLoginExit(cb: (e: { botId: string; code: number | null }) => void): () => void
  onBotsChanged(cb: () => void): () => void
}
