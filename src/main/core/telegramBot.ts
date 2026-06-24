/**
 * Inbound Telegram control bot — "Sentinel on your phone".
 *
 * Long-polls getUpdates and drives the SAME supervisor the GUI uses: fleet
 * status, start / stop / restart / logs / update. One bot token does both this
 * and the outbound crash alerts in notify.ts. No external deps — just fetch
 * against the Bot API, mirroring sendTelegram().
 *
 * Only ONE getUpdates poller may run per token (Telegram returns 409 for two),
 * so the caller starts this in exactly one process: the headless `--agent`
 * monitor when installed, otherwise the GUI (see index.ts).
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Bot } from '@shared/types'
import * as sup from './supervisor'
import { botLogPaths, SENTINEL_HOME } from './paths'
import {
  getAgentConfig,
  setAgentConfig,
  getAutoApprove,
  setAutoApprove,
  isUserApproved,
  isUserIgnored,
  approveUser,
  rejectUser,
  addPendingRequest,
  recordUserProfile,
  getGithubToken,
  setGithubToken,
  getLimits
} from './config'
import { botsVisibleTo, can } from './miniapp/authz'
import { findEntry, botsOwnedBy, setBotOwner } from './registry'
import { ping, chatStream } from './agent/provider'
import { runAgent, inferEnvSpec, type EnvVarSpec } from './agent/runtime'
import { getHistory, appendTurn, clearMemory } from './agent/memory'
import { exec } from './exec'
import { procStat, systemBrief, type ProcStat } from './stats'
import { muteBot } from './monitor'

const SECRET_KEY_RE = /TOKEN|HASH|SECRET|PASSWORD|KEY|API_ID|SESSION/i

const API = 'https://api.telegram.org'
const MAX_MSG = 3500 // keep clear of Telegram's 4096 hard cap

export interface ControlConfig {
  enabled: boolean
  /** Bot token (shared with the notifier). */
  token: string
  /** The only chat allowed to issue commands (your DM with the bot). */
  ownerChatId: string
}

// ---- pure helpers (unit-tested) -------------------------------------------

/** A chat may drive the fleet only if it matches the configured owner. */
export function isAuthorized(chatId: number | string, ownerChatId: string): boolean {
  return ownerChatId.trim().length > 0 && String(chatId) === ownerChatId.trim()
}

/** Split "/cmd@bot arg rest" into a lowercased command and its argument. */
export function parseCommand(text: string): { cmd: string; arg: string } {
  const trimmed = text.trim()
  const sp = trimmed.indexOf(' ')
  const head = sp === -1 ? trimmed : trimmed.slice(0, sp)
  const arg = sp === -1 ? '' : trimmed.slice(sp + 1).trim()
  const cmd = head.replace(/@.*$/, '').toLowerCase()
  return { cmd, arg }
}

/** Resolve a bot by exact id, id prefix, or case-insensitive name substring. */
export function resolveBot(bots: Bot[], query: string): Bot | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  return (
    bots.find((b) => b.manifest.id.toLowerCase() === q) ??
    bots.find((b) => b.manifest.name.toLowerCase() === q) ??
    bots.find((b) => b.manifest.id.toLowerCase().startsWith(q)) ??
    bots.find((b) => b.manifest.name.toLowerCase().includes(q)) ??
    null
  )
}

/** Filter a bot list to only those visible to the given uid. Host sees all. */
export function filterVisible<T extends { manifest: { id: string } }>(bots: T[], uid: number, isHost: boolean): T[] {
  const visible = new Set(botsVisibleTo(uid, isHost).map((e) => e.id))
  return bots.filter((b) => visible.has(b.manifest.id))
}

export function statusEmoji(status: string): string {
  switch (status) {
    case 'running':
      return '🟢'
    case 'crashed':
    case 'crash-looping':
      return '🔴'
    case 'scheduled':
      return '🟡'
    case 'starting':
      return '🟠'
    default:
      return '⚪️'
  }
}

/** One-line fleet summary (HTML). */
export function formatFleet(bots: Bot[]): string {
  if (bots.length === 0) return '<b>No bots imported yet.</b>'
  const running = bots.filter((b) => b.runtime.status === 'running').length
  const bad = bots.filter((b) => b.runtime.status === 'crashed' || b.runtime.status === 'crash-looping').length
  const head = `🛰️ <b>${running}/${bots.length} running</b>${bad ? ` · ${bad} down` : ''}`
  const lines = bots.map((b) => {
    const r = b.runtime
    const extra =
      r.status === 'running'
        ? r.pid
          ? ` · pid ${r.pid}`
          : ''
        : r.status === 'crashed'
          ? ` · exit ${r.lastExitCode ?? '?'}`
          : ''
    return `${statusEmoji(r.status)} <b>${escapeHtml(b.manifest.name)}</b> — ${r.status}${extra}`
  })
  return [head, '', ...lines].join('\n')
}

export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Tail the last `n` lines of a bot's stdout+stderr logs. */
export function tailBotLogs(botId: string, n = 30): string {
  const { out, err } = botLogPaths(botId)
  const read = (p: string): string => {
    try {
      return existsSync(p) ? readFileSync(p, 'utf8') : ''
    } catch {
      return ''
    }
  }
  const text = (read(out) + read(err)).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  const lines = text.split('\n').filter(Boolean)
  const tail = lines.slice(-n).join('\n')
  return tail || '(no output yet)'
}

type Keyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
type ReplyMarkup = Keyboard | null

function mainMenuKeyboard(): Keyboard {
  return { inline_keyboard: [[{ text: '📊 Status', callback_data: 'status' }, { text: '🤖 Bots', callback_data: 'list' }]] }
}

function listKeyboard(bots: Bot[]): Keyboard {
  const rows = bots.slice(0, 20).map((b) => [
    { text: `${statusEmoji(b.runtime.status)} ${b.manifest.name}`, callback_data: `bot:${b.manifest.id}` }
  ])
  rows.push([{ text: '⬅️ Back', callback_data: 'home' }])
  return { inline_keyboard: rows }
}

function botKeyboard(b: Bot): Keyboard {
  const id = b.manifest.id
  return {
    inline_keyboard: [
      [
        { text: '▶️ Start', callback_data: `do:start:${id}` },
        { text: '⏹ Stop', callback_data: `do:stop:${id}` },
        { text: '🔁 Restart', callback_data: `do:restart:${id}` }
      ],
      [
        { text: '🔄 Refresh', callback_data: `bot:${id}` },
        { text: '📄 Logs', callback_data: `logs:${id}` },
        { text: '🔑 Secrets', callback_data: `env:${id}` },
        ...(b.manifest.source.type === 'git' ? [{ text: '⬇️ Update', callback_data: `do:update:${id}` }] : [])
      ],
      [
        { text: '🤖 Ask AI', callback_data: `aiask:${id}` },
        { text: '🛠 Fix', callback_data: `aifix:${id}` }
      ],
      [
        { text: '🗑 Remove', callback_data: `ask:remove:${id}` },
        { text: '⬅️ Bots', callback_data: 'list' }
      ]
    ]
  }
}

/** Inline list of a bot's env keys (✅ set / • missing). Keys referenced by index to keep callback_data short. */
function envKeyboard(botId: string, keys: string[], current: Record<string, string>): Keyboard {
  const rows = keys
    .slice(0, 16)
    .map((k, i) => [{ text: `${current[k] ? '✅' : '•'} ${k}`, callback_data: `sv:${botId}:${i}` }])
  rows.push([{ text: '⬅️ Back', callback_data: `bot:${botId}` }])
  return { inline_keyboard: rows }
}

/** Never reveal a secret's content — show only a length hint. */
export function maskSecret(v: string): string {
  return `•••• (${v.length} chars)`
}

/** Two-step guard for the only destructive action. */
function confirmRemoveKeyboard(id: string): Keyboard {
  return {
    inline_keyboard: [
      [
        { text: '✅ Yes, remove', callback_data: `do:remove:${id}` },
        { text: '✖️ Cancel', callback_data: `bot:${id}` }
      ]
    ]
  }
}

// ---- the bot ---------------------------------------------------------------

interface TgUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
}
interface TgChat {
  id: number
}
interface TgDocument {
  file_id: string
  file_name?: string
  file_size?: number
  mime_type?: string
}
interface TgMessage {
  message_id: number
  text?: string
  caption?: string
  document?: TgDocument
  chat: TgChat
  from?: TgUser
}
interface TgCallback {
  id: string
  data?: string
  message?: TgMessage
  from: TgUser
}
interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallback
}

const HELP =
  '<b>Sentinel</b> — control your bots from here.\n\n' +
  '/status — fleet overview\n' +
  '/stats — live CPU / memory per bot + totals\n' +
  '/list — pick a bot to control\n' +
  '/logs &lt;name&gt; — recent log lines\n' +
  '/update &lt;name&gt; — pull latest (git bots)\n' +
  '/setenv &lt;name&gt; — set a secret (auto-deletes your message)\n' +
  '/setup &lt;name&gt; — AI-guided env setup, one var at a time\n' +
  '/ask [name] &lt;question&gt; — ask the AI about a bot (name optional once selected)\n' +
  '/fix [name] &lt;task&gt; — let the AI edit/fix it (you approve each change)\n' +
  'ai &lt;message&gt; — chat with the AI directly (streams the reply)\n' +
  '/dev &lt;task&gt; — let the AI edit Sentinel’s OWN code (advanced)\n' +
  '/reset — clear the AI’s conversation memory (start fresh)\n' +
  '/push [name] — push the bot’s current state to a sentinel-live branch\n' +
  '/apply — rebuild &amp; restart Sentinel (apply /dev changes)\n' +
  '/upload — send a .zip to import a bot, or a file to add to one\n' +
  '/clone &lt;github url&gt; — import a repo as a new bot (or just paste the link)\n' +
  '/yolo — toggle auto-approve (skip all approval prompts)\n' +
  '/setai — configure the AI provider\n' +
  '/remove &lt;name&gt; — delete a bot (asks first)\n' +
  '/cancel — abort the current prompt\n' +
  '/help — this message\n\n' +
  'Or just tap the buttons below.'

function postTelegramJson(token: string, method: string, params: unknown, signal?: AbortSignal): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-tg-'))
  const bodyPath = join(dir, 'body.json')
  const cfgPath = join(dir, 'curl.conf')
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  writeFileSync(bodyPath, JSON.stringify(params), { mode: 0o600 })
  writeFileSync(
    cfgPath,
    [
      'silent',
      'show-error',
      'fail-with-body',
      'location',
      'ipv4',
      'resolve = "api.telegram.org:443:149.154.166.110"',
      'request = "POST"',
      'connect-timeout = 15',
      method === 'getUpdates' ? 'max-time = 65' : 'max-time = 35',
      `url = "${esc(`${API}/bot${token}/${method}`)}"`,
      'header = "Content-Type: application/json"',
      `data-binary = "@${esc(bodyPath)}"`
    ].join('\n'),
    { mode: 0o600 }
  )
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/curl', ['--config', cfgPath], { timeout: method === 'getUpdates' ? 70_000 : 40_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      rmSync(dir, { recursive: true, force: true })
      if (err) reject(new Error(stderr || err.message))
      else resolve(stdout)
    })
    if (signal) {
      if (signal.aborted) child.kill()
      else signal.addEventListener('abort', () => child.kill(), { once: true })
    }
  })
}

export class TelegramControlBot {
  private running = false
  private offset = 0
  private abort: AbortController | null = null
  private token = ''
  /** Per-chat one-shot "awaiting a typed answer" (secret or wizard value). */
  private awaiting = new Map<
    number,
    { secret: boolean; promptId?: number; ts: number; resolve: (v: string | null) => void }
  >()
  /** Per-chat pending agent approval (propose-then-confirm). */
  private approvals = new Map<number, (ok: boolean) => void>()
  /** Chats with a running wizard/agent session (one at a time). */
  private busy = new Set<number>()
  /** Last bot a chat looked at — lets /ask and /fix omit the bot name. */
  private lastBot = new Map<number, string>()
  /** A git URL awaiting an Import/No decision per chat. */
  private pendingClone = new Map<number, string>()

  constructor(
    private getConfig: () => ControlConfig,
    private onChange?: () => void,
    /** Injected by index.ts (needs Electron app): relaunch the process. */
    private restartApp?: () => void
  ) {}

  /** Returns false if config is incomplete (nothing started). */
  start(): boolean {
    if (this.running) return true
    const cfg = this.getConfig()
    if (!cfg.enabled || !cfg.token) return false
    this.running = true
    this.token = cfg.token
    void this.registerCommands()
    void this.loop()
    return true
  }

  stop(): void {
    this.running = false
    this.abort?.abort()
    this.abort = null
    // Release any awaited promises so detached sessions unwind cleanly.
    for (const a of this.awaiting.values()) a.resolve(null)
    this.awaiting.clear()
    for (const r of this.approvals.values()) r(false)
    this.approvals.clear()
    this.busy.clear()
  }

  get isRunning(): boolean {
    return this.running
  }

  private async visibleBots(chatId: number, isOwner: boolean): Promise<Bot[]> {
    return filterVisible(await sup.listBots(), chatId, isOwner)
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        this.abort = new AbortController()
        const timer = setTimeout(() => this.abort?.abort(), 60_000)
        let updates: TgUpdate[] = []
        try {
          updates = (await this.call('getUpdates', { offset: this.offset, timeout: 50 }, this.abort.signal)) ?? []
        } finally {
          clearTimeout(timer)
        }
        for (const u of updates) {
          this.offset = u.update_id + 1
          try {
            await this.handle(u)
          } catch {
            /* never let one update kill the loop */
          }
        }
      } catch {
        if (!this.running) break
        // Network blip, abort, or 409 (another poller) — back off and retry.
        await sleep(3000)
      }
    }
  }

  private async handle(u: TgUpdate): Promise<void> {
    const cfg = this.getConfig()
    if (u.callback_query) return this.onCallback(u.callback_query, cfg)
    if (u.message?.document) {
      void this.onDocument(u.message, cfg) // detached: download/import can take a while
      return
    }
    if (u.message?.text) return this.onMessage(u.message, cfg)
  }

  private async onMessage(msg: TgMessage, cfg: ControlConfig): Promise<void> {
    const chatId = msg.chat.id
    const isOwner = isAuthorized(chatId, cfg.ownerChatId)
    const isApproved = isUserApproved(chatId)
    const isIgnored = isUserIgnored(chatId)

    // Learn who this is (cheap upsert; only writes when names actually change),
    // so the dashboard can show real names instead of bare numeric IDs.
    if (msg.from) {
      recordUserProfile({
        id: chatId,
        firstName: msg.from.first_name,
        lastName: msg.from.last_name,
        username: msg.from.username
      })
    }

    if (!isOwner && isIgnored) {
      // Admin chose Ignore/Reject. Stay quiet so ignored users cannot keep
      // generating access-request spam.
      return
    }

    if (!isOwner && !isApproved) {
      const text = msg.text ?? ''
      const trimmed = text.trim()
      if (trimmed.toLowerCase().startsWith('/start') || trimmed.toLowerCase().startsWith('/help')) {
        // Forward the access request to the owner with approve/reject buttons
        const user = msg.from
        // Persist the request so it also shows in the Mini App access queue.
        addPendingRequest({
          id: chatId,
          firstName: user?.first_name,
          lastName: user?.last_name,
          username: user?.username
        })
        const firstName = user?.first_name ?? 'Unknown'
        const lastName = user?.last_name ?? ''
        const username = user?.username ? `@${user.username}` : 'none'
        const fullName = lastName ? `${firstName} ${lastName}` : firstName
        const ownerChatId = Number(cfg.ownerChatId)
        if (ownerChatId) {
          await this.send(
            ownerChatId,
            `🔔 <b>New access request!</b>\n\n` +
              `👤 <b>Name:</b> ${escapeHtml(fullName)}\n` +
              `🆔 <b>Username:</b> ${escapeHtml(username)}\n` +
              `💬 <b>Chat ID:</b> <code>${chatId}</code>\n` +
              `🕐 <b>Time:</b> ${new Date().toLocaleString()}`,
            {
              inline_keyboard: [
                [
                  { text: '✅ Approve', callback_data: `approve:${chatId}` },
                  { text: '❌ Reject', callback_data: `reject:${chatId}` }
                ]
              ]
            }
          )
          await this.send(chatId, '⏳ Your access request has been sent to the admin. Please wait for approval.')
        } else {
          await this.send(chatId, '⚠️ No admin configured. Cannot process access requests.')
        }
      } else if (isUserApproved(chatId)) {
        // Already approved — shouldn't reach here, but just in case
        await this.send(chatId, '✅ You are approved. Use /start to begin.')
      } else {
        await this.send(chatId, '⛔️ You are not authorized. Please wait for admin approval.')
      }
      return
    }

    const text = msg.text ?? ''
    const trimmed = text.trim()

    // /cancel aborts a pending prompt, approval, or session-wait.
    if (trimmed.toLowerCase().startsWith('/cancel')) {
      let did = false
      const aw = this.awaiting.get(chatId)
      if (aw) {
        this.awaiting.delete(chatId)
        aw.resolve(null)
        did = true
      }
      const ap = this.approvals.get(chatId)
      if (ap) {
        this.approvals.delete(chatId)
        ap(false)
        did = true
      }
      await this.send(chatId, did ? 'Cancelled.' : 'Nothing to cancel.')
      return
    }

    // A pending question consumes the next non-command message (secrets deleted).
    const aw = this.awaiting.get(chatId)
    if (aw && !trimmed.startsWith('/')) {
      if (Date.now() - aw.ts <= 10 * 60_000) {
        if (aw.secret) {
          await this.deleteMessage(chatId, msg.message_id)
          if (aw.promptId) await this.deleteMessage(chatId, aw.promptId)
        }
        this.awaiting.delete(chatId)
        aw.resolve(trimmed)
        return
      }
      this.awaiting.delete(chatId)
      aw.resolve(null)
    }

    // A bare git URL → offer to import it as a new bot.
    const gitUrl = gitUrlFrom(trimmed)
    if (gitUrl) {
      this.pendingClone.set(chatId, gitUrl)
      await this.send(chatId, `📥 Import <b>${escapeHtml(gitUrl)}</b> as a new bot?`, {
        inline_keyboard: [
          [
            { text: '✅ Import', callback_data: 'clone:yes' },
            { text: '💬 No, just chat', callback_data: 'clone:no' }
          ]
        ]
      })
      return
    }

    // Any non-command message is a direct chat with the AI ("talk straight").
    // A leading "ai" is optional and stripped, so `ai what's up` and `what's up`
    // behave the same. Tenants are directed to use /ask instead.
    if (!trimmed.startsWith('/')) {
      if (!isOwner) { await this.send(chatId, '💬 Open your dashboard to chat, or use /ask <your bot> <question>.'); return }
      void this.runChat(chatId, trimmed.replace(/^ai[\s,:]+/i, ''))
      return
    }

    const { cmd, arg } = parseCommand(text)
    switch (cmd) {
      case '/start':
      case '/help':
        await this.send(chatId, HELP, mainMenuKeyboard())
        break
      case '/status': {
        const bots = await this.visibleBots(chatId, isOwner)
        await this.send(chatId, formatFleet(bots), mainMenuKeyboard())
        break
      }
      case '/list': {
        const bots = await this.visibleBots(chatId, isOwner)
        await this.send(chatId, '🤖 <b>Your bots</b> — tap one:', listKeyboard(bots))
        break
      }
      case '/stats':
        void this.runStats(chatId, isOwner)
        break
      case '/logs': {
        const bots = await this.visibleBots(chatId, isOwner)
        const b = resolveBot(bots, arg)
        if (!b) await this.send(chatId, `No bot matches “${escapeHtml(arg)}”. Try /list.`)
        else await this.send(chatId, logsBlock(b))
        break
      }
      case '/update': {
        const bots = await this.visibleBots(chatId, isOwner)
        const b = resolveBot(bots, arg)
        if (!b) await this.send(chatId, `No bot matches “${escapeHtml(arg)}”. Try /list.`)
        else await this.runAction('update', b.manifest.id, chatId)
        break
      }
      case '/setenv': {
        const bots = await this.visibleBots(chatId, isOwner)
        const b = resolveBot(bots, arg)
        if (!b) await this.send(chatId, `No bot matches “${escapeHtml(arg)}”. Try /list.`)
        else await this.showSecrets(b.manifest.id, chatId)
        break
      }
      case '/setup': {
        const bots = await this.visibleBots(chatId, isOwner)
        const b = resolveBot(bots, arg)
        if (!b) await this.send(chatId, `No bot matches “${escapeHtml(arg)}”. Try /list.`)
        else void this.runEnvWizard(chatId, b.manifest.id) // detached so polling continues
        break
      }
      case '/ask':
        void this.runAgentSession(chatId, arg, false)
        break
      case '/fix':
        void this.runAgentSession(chatId, arg, true)
        break
      case '/ai':
        if (!isOwner) { await this.send(chatId, '💬 Open your dashboard to chat, or use /ask <your bot> <question>.'); break }
        void this.runChat(chatId, arg)
        break
      case '/dev':
        if (!isOwner) { await this.send(chatId, '🛠 Host-only command — manage your bots in the dashboard.'); break }
        void this.runSelfEdit(chatId, arg)
        break
      case '/reset': {
        const n = clearMemory(chatId)
        await this.send(
          chatId,
          n ? '🧠 Memory cleared — the AI will start fresh next time.' : 'No conversation memory to clear.'
        )
        break
      }
      case '/push': {
        if (!isOwner) { await this.send(chatId, '🛠 Host-only command — manage your bots in the dashboard.'); break }
        const bots = await sup.listBots()
        const b = resolveBot(bots, arg) ?? (this.lastBot.get(chatId) ? bots.find((x) => x.manifest.id === this.lastBot.get(chatId)) : null) ?? (bots.length === 1 ? bots[0] : null)
        if (!b) await this.send(chatId, `Which bot? Try <code>/push &lt;name&gt;</code> or /list.`)
        else void this.runPushLive(chatId, b)
        break
      }
      case '/apply':
        if (!isOwner) { await this.send(chatId, '🛠 Host-only command — manage your bots in the dashboard.'); break }
        void this.runApply(chatId, true)
        break
      case '/upload':
        await this.send(
          chatId,
          '📎 <b>Upload a file</b>\n• Send a <b>.zip</b> of a bot project → I import it as a new bot (use the caption to name it).\n• Send any other file → I add it to the bot you’ve selected (tap one in /list first).\n• Or send a <b>GitHub link</b> (or use /clone) to import a repo.'
        )
        break
      case '/clone':
      case '/import': {
        const url = gitUrlFrom(arg) ?? (/^https?:\/\/\S+/i.test(arg.trim()) ? arg.trim() : null)
        if (!url) await this.send(chatId, 'Usage: <code>/clone https://github.com/owner/repo</code>')
        else void this.runClone(chatId, url)
        break
      }
      case '/yolo': {
        const on = !getAutoApprove()
        setAutoApprove(on)
        await this.send(
          chatId,
          on
            ? '⚡️ <b>Auto-approve ON</b> — agent edits, commands, uploads and self-edits run <b>without</b> asking. Send /yolo again to turn it off.'
            : '🛡 <b>Auto-approve OFF</b> — I’ll ask before each change again.'
        )
        break
      }
      case '/setai':
        void this.runSetAi(chatId)
        break
      case '/remove': {
        const bots = await this.visibleBots(chatId, isOwner)
        const b = resolveBot(bots, arg)
        if (!b) await this.send(chatId, `No bot matches “${escapeHtml(arg)}”. Try /list.`)
        else
          await this.send(
            chatId,
            `⚠️ Remove <b>${escapeHtml(b.manifest.name)}</b>?\nThis stops it and deletes its folder under bots/.`,
            confirmRemoveKeyboard(b.manifest.id)
          )
        break
      }
      default:
        await this.send(chatId, 'Unknown command. /help for options.', mainMenuKeyboard())
    }
  }

  private async onCallback(cb: TgCallback, cfg: ControlConfig): Promise<void> {
    const chatId = cb.message?.chat.id ?? cb.from.id
    const messageId = cb.message?.message_id
    if (!isAuthorized(chatId, cfg.ownerChatId)) {
      await this.answer(cb.id, 'Not authorized')
      return
    }
    const data = cb.data ?? ''

    if (data === 'home') {
      await this.answer(cb.id)
      await this.edit(chatId, messageId, HELP, mainMenuKeyboard())
      return
    }
    if (data === 'status') {
      await this.answer(cb.id)
      const bots = await sup.listBots()
      await this.edit(chatId, messageId, formatFleet(bots), mainMenuKeyboard())
      return
    }
    if (data === 'list') {
      await this.answer(cb.id)
      const bots = await sup.listBots()
      await this.edit(chatId, messageId, '🤖 <b>Your bots</b> — tap one:', listKeyboard(bots))
      return
    }
    if (data.startsWith('bot:')) {
      await this.answer(cb.id)
      await this.showBot(data.slice(4), chatId, messageId)
      return
    }
    if (data.startsWith('ask:remove:')) {
      await this.answer(cb.id)
      const id = data.slice('ask:remove:'.length)
      const b = (await sup.listBots()).find((x) => x.manifest.id === id)
      if (!b) await this.edit(chatId, messageId, 'That bot is gone. /list', mainMenuKeyboard())
      else
        await this.edit(
          chatId,
          messageId,
          `⚠️ Remove <b>${escapeHtml(b.manifest.name)}</b>?\nThis stops it and deletes its folder under bots/.`,
          confirmRemoveKeyboard(id)
        )
      return
    }
    if (data.startsWith('logs:')) {
      await this.answer(cb.id, 'Fetching logs…')
      const bots = await sup.listBots()
      const b = bots.find((x) => x.manifest.id === data.slice(5))
      if (b) await this.send(chatId, logsBlock(b))
      return
    }
    if (data.startsWith('mute:')) {
      const id = data.slice('mute:'.length)
      muteBot(id, 60 * 60 * 1000)
      await this.answer(cb.id, 'Muted for 1h')
      if (messageId) await this.edit(chatId, messageId, `${cb.message?.text ?? 'Crash alert'}\n\n🔕 <b>Muted for 1h</b>`, null)
      return
    }
    if (data.startsWith('env:')) {
      await this.answer(cb.id)
      await this.showSecrets(data.slice(4), chatId, messageId)
      return
    }
    if (data.startsWith('sv:')) {
      const [, botId, idxStr] = data.split(':')
      const env = sup.getEnv(botId)
      const key = env.keys[Number(idxStr)]
      if (!key) {
        await this.answer(cb.id, 'That key is gone')
        return
      }
      await this.answer(cb.id)
      void this.collectSecretForKey(chatId, botId, key) // detached so polling continues
      return
    }
    if (data.startsWith('approve:') || data.startsWith('reject:')) {
      const targetChatId = Number(data.split(':')[1])
      if (!Number.isFinite(targetChatId)) {
        await this.answer(cb.id, 'Invalid access request')
        return
      }
      const approved = data.startsWith('approve:')
      if (approved) {
        approveUser(targetChatId)
        await this.answer(cb.id, 'Approved')
        await this.edit(
          chatId,
          messageId,
          `${cb.message?.text ?? 'Access request'}\n\n✅ <b>Approved</b> <code>${targetChatId}</code>`,
          null
        )
        await this.send(targetChatId, '✅ You are approved. Send /start to begin.').catch(() => undefined)
      } else {
        rejectUser(targetChatId)
        await this.answer(cb.id, 'Ignored')
        await this.edit(
          chatId,
          messageId,
          `${cb.message?.text ?? 'Access request'}\n\n🚫 <b>Ignored</b> <code>${targetChatId}</code>`,
          null
        )
      }
      return
    }
    if (data === 'appr:y' || data === 'appr:n' || data === 'appr:all') {
      await this.answer(cb.id)
      if (data === 'appr:all') {
        setAutoApprove(true)
        await this.send(chatId, '⚡️ <b>Auto-approve ON</b> — I won’t ask again. Use /yolo to turn it back off.')
      }
      const r = this.approvals.get(chatId)
      if (r) {
        this.approvals.delete(chatId)
        r(data !== 'appr:n')
      }
      return
    }
    if (data.startsWith('ai:')) {
      await this.answer(cb.id)
      void this.collectAi(chatId, data.slice(3))
      return
    }
    if (data.startsWith('aiask:') || data.startsWith('aifix:')) {
      await this.answer(cb.id)
      void this.startAgentForBot(chatId, data.slice(6), data.startsWith('aifix:'))
      return
    }
    if (data === 'apply') {
      await this.answer(cb.id, 'Applying…')
      void this.runApply(chatId, false) // already an explicit tap → no extra confirm
      return
    }
    if (data === 'clone:yes' || data === 'clone:no') {
      await this.answer(cb.id)
      const url = this.pendingClone.get(chatId)
      this.pendingClone.delete(chatId)
      if (!url) {
        await this.send(chatId, 'That import expired — send the link again.')
      } else if (data === 'clone:yes') {
        void this.runClone(chatId, url)
      } else {
        void this.runChat(chatId, url) // they meant to chat about it
      }
      return
    }
    if (data.startsWith('do:')) {
      const [, action, id] = data.split(':')
      await this.answer(cb.id, `${action}…`)
      await this.runAction(action, id, chatId, messageId)
      return
    }
    await this.answer(cb.id)
  }

  /** Perform a fleet action and report back (editing the detail card if given). */
  private async runAction(action: string, id: string, chatId: number, messageId?: number): Promise<void> {
    try {
      // Destructive: removeBot returns void and the bot stops existing, so it
      // can't share the "show the updated detail card" path below.
      if (action === 'remove') {
        const name = (await sup.listBots()).find((x) => x.manifest.id === id)?.manifest.name ?? id
        await sup.removeBot(id)
        this.onChange?.()
        const all = await sup.listBots()
        const text = `🗑 <b>${escapeHtml(name)}</b> removed.\n\n🤖 <b>Your bots</b> — tap one:`
        if (messageId) await this.edit(chatId, messageId, text, listKeyboard(all))
        else await this.send(chatId, text)
        return
      }
      let bot: Bot
      switch (action) {
        case 'start':
          bot = await sup.start(id)
          break
        case 'stop':
          bot = await sup.stop(id)
          break
        case 'restart':
          bot = await sup.restart(id)
          break
        case 'update':
          if (messageId) await this.edit(chatId, messageId, '⬇️ Pulling latest…')
          else await this.send(chatId, '⬇️ Pulling latest…')
          bot = await sup.updateBot(id, () => {})
          break
        default:
          return
      }
      this.onChange?.()
      const note = `✅ <b>${escapeHtml(bot.manifest.name)}</b> — ${action} done (${statusEmoji(bot.runtime.status)} ${bot.runtime.status})`
      if (messageId) await this.edit(chatId, messageId, `${botDetail(bot)}\n\n${note}`, botKeyboard(bot))
      else await this.send(chatId, note)
      // Stats are ~0 the instant a process starts — re-render once it has settled.
      if (messageId && (action === 'start' || action === 'restart')) {
        setTimeout(() => void this.showBot(id, chatId, messageId), 2500)
      }
    } catch (e) {
      await this.send(chatId, `⚠️ ${action} failed: ${escapeHtml((e as Error).message?.split('\n')[0] ?? String(e))}`)
    }
  }

  /** Fleet statistics: per-bot live CPU%, memory (+ % of RAM), uptime, and totals. */
  private async runStats(chatId: number, isOwner: boolean): Promise<void> {
    const bots = filterVisible(await sup.listBots(), chatId, isOwner)
    if (!bots.length) {
      await this.send(chatId, 'No bots imported yet.')
      return
    }
    // Sample instantaneous CPU for every running bot in parallel.
    const rows = await Promise.all(
      bots.map(async (b) => {
        const r = b.runtime
        const s = r.pid && r.status === 'running' ? await procStat(r.pid, 700) : null
        return { b, s }
      })
    )
    const sys = systemBrief()
    let totCpu = 0
    let totMem = 0
    let running = 0
    const lines = rows.map(({ b, s }) => {
      const r = b.runtime
      const name = `${statusEmoji(r.status)} <b>${escapeHtml(b.manifest.name)}</b>`
      if (s && r.status === 'running') {
        running++
        if (s.cpu != null) totCpu += s.cpu
        if (s.memMB != null) totMem += s.memMB
        const mem = s.memMB != null ? `${s.memMB} MB${s.memPct != null ? ` (${s.memPct}%)` : ''}` : '—'
        return `${name} — ${s.cpu != null ? s.cpu.toFixed(1) : '—'}% CPU · ${mem}${s.uptime ? ` · up ${s.uptime}` : ''}`
      }
      return `${name} — ${r.status}`
    })
    const ramPct = totMem ? ((totMem / (sys.totalGB * 1024)) * 100).toFixed(1) : '0'
    const text = [
      '📊 <b>Fleet statistics</b>',
      '',
      ...lines,
      '',
      `Running <b>${running}/${bots.length}</b> · total CPU <b>${totCpu.toFixed(1)}%</b> · RAM <b>${totMem} MB</b> (${ramPct}%)`,
      `<i>System: ${sys.cores} cores · ${sys.totalGB} GB RAM. CPU% is per core (100% = one full core).</i>`
    ].join('\n')
    await this.send(chatId, text)
  }

  private async showBot(id: string, chatId: number, messageId?: number): Promise<void> {
    const bots = await sup.listBots()
    const b = bots.find((x) => x.manifest.id === id)
    if (!b) {
      await this.edit(chatId, messageId, 'That bot is gone. /list', mainMenuKeyboard())
      return
    }
    this.lastBot.set(chatId, id) // so /ask & /fix can omit the bot name
    // Sample instantaneous CPU/mem for a running bot so the card isn't stuck at 0.
    let live: ProcStat | null = null
    if (b.runtime.pid && b.runtime.status === 'running') {
      live = await procStat(b.runtime.pid, 600)
    }
    await this.edit(chatId, messageId, botDetail(b, live), botKeyboard(b))
  }

  private async showSecrets(botId: string, chatId: number, messageId?: number): Promise<void> {
    const bot = (await sup.listBots()).find((x) => x.manifest.id === botId)
    if (!bot) {
      await this.edit(chatId, messageId, 'That bot is gone. /list', mainMenuKeyboard())
      return
    }
    const env = sup.getEnv(botId)
    const missing = env.keys.filter((k) => !env.current[k]).length
    const text =
      `🔑 <b>${escapeHtml(bot.manifest.name)}</b> — secrets\n` +
      (env.keys.length
        ? `${env.keys.length - missing}/${env.keys.length} set${missing ? ` · ${missing} missing` : ''}. Tap a key to set its value:`
        : 'No env keys detected for this bot.')
    await this.edit(chatId, messageId, text, envKeyboard(botId, env.keys, env.current))
  }

  // ---- input + approval primitives (resolved by onMessage / onCallback) ----

  /** Prompt the user and resolve with their next message (or null on cancel/timeout). */
  private async askValue(chatId: number, prompt: string, opts: { secret?: boolean } = {}): Promise<string | null> {
    const prev = this.awaiting.get(chatId)
    if (prev) {
      this.awaiting.delete(chatId)
      prev.resolve(null)
    }
    const sent = await this.sendReturn(chatId, prompt, opts.secret ? { force_reply: true } : undefined)
    return new Promise<string | null>((resolve) => {
      this.awaiting.set(chatId, { secret: !!opts.secret, promptId: sent?.message_id, ts: Date.now(), resolve })
    })
  }

  /** Show Approve/Reject buttons and resolve with the choice. */
  private async waitApproval(chatId: number, summary: string): Promise<boolean> {
    // Bypass mode: run everything without asking.
    if (getAutoApprove()) {
      await this.send(chatId, `⚡️ Auto-approved: <i>${escapeHtml(summary)}</i>`)
      return true
    }
    const prev = this.approvals.get(chatId)
    if (prev) {
      this.approvals.delete(chatId)
      prev(false)
    }
    await this.send(chatId, `🤖 Proposed action:\n<pre>${escapeHtml(summary)}</pre>\nApprove?`, {
      inline_keyboard: [
        [{ text: '✅ Approve', callback_data: 'appr:y' }, { text: '✖️ Reject', callback_data: 'appr:n' }],
        [{ text: '⚡️ Always approve (stop asking)', callback_data: 'appr:all' }]
      ]
    })
    return new Promise<boolean>((resolve) => {
      this.approvals.set(chatId, resolve)
    })
  }

  /** Collect one secret for a tapped key, scrub the message, and persist. */
  private async collectSecretForKey(chatId: number, botId: string, key: string): Promise<void> {
    const value = await this.askValue(
      chatId,
      `🔑 Send the value for <b>${escapeHtml(key)}</b> now.\n` +
        `I’ll delete your message instantly. <i>(It still briefly reaches Telegram — use the app for top-secret values.)</i>\n` +
        `/cancel to abort.`,
      { secret: true }
    )
    if (value == null || value === '') {
      await this.send(chatId, 'Nothing saved.')
      return
    }
    try {
      const env = sup.getEnv(botId)
      const next = { ...env.current, [key]: value }
      await sup.saveEnv(botId, next)
      this.onChange?.()
      await this.send(
        chatId,
        `✅ <b>${escapeHtml(key)}</b> saved (${maskSecret(value)}). Your message was deleted.`,
        envKeyboard(botId, env.keys, next)
      )
    } catch (e) {
      await this.send(chatId, `⚠️ Could not save: ${escapeHtml((e as Error).message?.split('\n')[0] ?? String(e))}`)
    }
  }

  // ---- AI provider setup over Telegram ----

  private async runSetAi(chatId: number): Promise<void> {
    const a = getAgentConfig()
    await this.send(
      chatId,
      `🧠 <b>AI provider</b>\n` +
        `Base URL: ${a.baseUrl ? escapeHtml(a.baseUrl) : '—'}\n` +
        `Model: ${a.model ? escapeHtml(a.model) : '—'}\n` +
        `Key: ${a.apiKey ? 'set ✓' : '—'}\n\nWhat do you want to set?`,
      {
        inline_keyboard: [
          [{ text: 'Base URL', callback_data: 'ai:url' }, { text: 'Model', callback_data: 'ai:model' }],
          [{ text: 'API key', callback_data: 'ai:key' }, { text: 'Test', callback_data: 'ai:test' }]
        ]
      }
    )
  }

  private async collectAi(chatId: number, field: string): Promise<void> {
    if (field === 'test') {
      const a = getAgentConfig()
      if (!a.ready) {
        await this.send(chatId, 'Set base URL, model, and key first.')
        return
      }
      await this.send(chatId, 'Testing…')
      const ok = await ping({ baseUrl: a.baseUrl, apiKey: a.apiKey, model: a.model })
      await this.send(chatId, ok ? '✅ AI provider works.' : '⚠️ Test failed — check base URL / model / key.')
      return
    }
    const labels: Record<string, string> = {
      url: 'base URL (e.g. https://openrouter.ai/api/v1)',
      model: 'model id (e.g. openai/gpt-4o-mini)',
      key: 'API key'
    }
    const secret = field === 'key'
    const v = await this.askValue(chatId, `Send the ${labels[field] ?? field}:`, { secret })
    if (v == null || v === '') {
      await this.send(chatId, 'Nothing changed.')
      return
    }
    if (field === 'url') setAgentConfig({ baseUrl: v })
    else if (field === 'model') setAgentConfig({ model: v })
    else if (field === 'key') setAgentConfig({ key: v })
    else {
      await this.send(chatId, 'Unknown field.')
      return
    }
    await this.send(chatId, secret ? `✅ API key saved (${maskSecret(v)}).` : '✅ Saved.')
  }

  // ---- AI env wizard: ask each variable one by one ----

  private async runEnvWizard(chatId: number, botId: string): Promise<void> {
    if (this.busy.has(chatId)) {
      await this.send(chatId, 'A session is already running — /cancel first.')
      return
    }
    this.busy.add(chatId)
    try {
      const bot = (await sup.listBots()).find((x) => x.manifest.id === botId)
      if (!bot) {
        await this.send(chatId, 'That bot is gone.')
        return
      }
      const env = sup.getEnv(botId)
      let specs: EnvVarSpec[] = []
      const provider = getAgentConfig()
      if (provider.ready) {
        await this.send(chatId, '🧠 Reading the bot to understand its variables…')
        try {
          specs = await inferEnvSpec(
            { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model },
            bot.dir,
            env.keys
          )
        } catch {
          specs = []
        }
      }
      // Fallback when AI is off or returns nothing: use detected keys + heuristics.
      if (!specs.length) {
        specs = env.keys.map((k) => ({
          key: k,
          description: env.example[k] ? `Example: ${env.example[k]}` : 'Set this environment variable.',
          secret: SECRET_KEY_RE.test(k)
        }))
      }
      if (!specs.length) {
        await this.send(chatId, 'No environment variables found for this bot.')
        return
      }

      await this.send(
        chatId,
        `🧩 Setting up <b>${escapeHtml(bot.manifest.name)}</b> — ${specs.length} variable(s). I’ll ask one at a time.\n` +
          `Send <code>-</code> to keep an existing value, /cancel to stop.`
      )
      let setCount = 0
      for (const spec of specs) {
        const cur = sup.getEnv(botId).current[spec.key]
        const prompt =
          `<b>${escapeHtml(spec.key)}</b>${spec.secret ? ' 🔒' : ''}\n${escapeHtml(spec.description)}` +
          (cur ? '\n<i>(already set — send a new value or “-” to keep)</i>' : '')
        const v = await this.askValue(chatId, prompt, { secret: spec.secret })
        if (v == null) {
          await this.send(chatId, 'Setup stopped. Progress so far is saved.')
          return
        }
        if (v === '-' || v === '') continue
        const e = sup.getEnv(botId)
        await sup.saveEnv(botId, { ...e.current, [spec.key]: v })
        setCount++
        await this.send(chatId, `✅ ${escapeHtml(spec.key)} ${spec.secret ? `set (${maskSecret(v)})` : 'set'}.`)
      }
      this.onChange?.()
      const after = sup.getEnv(botId)
      const missing = after.keys.filter((k) => !after.current[k])
      const fresh = (await sup.listBots()).find((x) => x.manifest.id === botId) ?? bot
      await this.send(
        chatId,
        `🎉 Setup complete for <b>${escapeHtml(bot.manifest.name)}</b> — ${setCount} value(s) set.` +
          (missing.length ? `\nStill empty: ${missing.map(escapeHtml).join(', ')}` : ''),
        botKeyboard(fresh)
      )
    } finally {
      this.busy.delete(chatId)
    }
  }

  // ---- AI agent: /ask (read-only) and /fix (propose-then-confirm) ----

  /**
   * /ask & /fix. The bot name is optional: if the first word names a bot it's
   * used; otherwise we fall back to the last bot you looked at (or your only
   * bot), and treat the whole text as the question.
   */
  private async runAgentSession(chatId: number, arg: string, allowWrites: boolean): Promise<void> {
    if (!getAgentConfig().ready) {
      await this.send(chatId, 'AI is not configured. Use /setai (or the app → Preferences → AI agent).')
      return
    }
    const isOwner = isAuthorized(chatId, this.getConfig().ownerChatId)
    const bots = filterVisible(await sup.listBots(), chatId, isOwner)
    if (!bots.length) {
      await this.send(chatId, 'No bots imported yet.')
      return
    }
    const parts = arg.trim().split(/\s+/).filter(Boolean)
    let bot: Bot | null = null
    let question = arg.trim()
    if (parts.length) {
      const m = resolveBot(bots, parts[0])
      if (m) {
        bot = m
        question = parts.slice(1).join(' ')
      }
    }
    if (!bot) {
      const lastId = this.lastBot.get(chatId)
      bot = (lastId ? bots.find((b) => b.manifest.id === lastId) : null) ?? (bots.length === 1 ? bots[0] : null) ?? null
    }
    if (!bot) {
      await this.send(
        chatId,
        `Which bot? Either name it — <code>${allowWrites ? '/fix' : '/ask'} &lt;bot&gt; ${escapeHtml(question) || '…'}</code> — or tap a bot below and use its 🤖/🛠 buttons.`,
        listKeyboard(bots)
      )
      return
    }
    if (!question) {
      const q = await this.askValue(
        chatId,
        `🤖 What should I ${allowWrites ? 'do for' : 'tell you about'} <b>${escapeHtml(bot.manifest.name)}</b>? Send your request.`
      )
      if (q == null || q === '') {
        await this.send(chatId, 'Cancelled.')
        return
      }
      question = q
    }
    await this.runAgentForBot(chatId, bot, question, allowWrites && can(chatId, isOwner, findEntry(bot.manifest.id), 'editEnv'))
  }

  /** Entry point for the 🤖 Ask AI / 🛠 Fix buttons — prompts for the request.
   *  Currently reached only via host-only onCallback; can() gates are defense-in-depth for future non-host callers.
   */
  private async startAgentForBot(chatId: number, botId: string, allowWrites: boolean): Promise<void> {
    const b = (await sup.listBots()).find((x) => x.manifest.id === botId)
    if (!b) {
      await this.send(chatId, 'That bot is gone.')
      return
    }
    const isOwner = isAuthorized(chatId, this.getConfig().ownerChatId)
    if (!can(chatId, isOwner, findEntry(botId), 'view')) {
      await this.send(chatId, 'Not allowed.')
      return
    }
    this.lastBot.set(chatId, botId)
    if (!getAgentConfig().ready) {
      await this.send(chatId, 'AI is not configured. Use /setai (or the app → Preferences → AI agent).')
      return
    }
    const q = await this.askValue(
      chatId,
      `🤖 What should I ${allowWrites ? 'do for' : 'tell you about'} <b>${escapeHtml(b.manifest.name)}</b>? Send your request.`
    )
    if (q == null || q === '') {
      await this.send(chatId, 'Cancelled.')
      return
    }
    await this.runAgentForBot(chatId, b, q, allowWrites && can(chatId, isOwner, findEntry(botId), 'editEnv'))
  }

  /** Run the agent loop against one bot and stream progress to the chat. */
  private async runAgentForBot(chatId: number, b: Bot, question: string, allowWrites: boolean): Promise<void> {
    const provider = getAgentConfig()
    if (!provider.ready) {
      await this.send(chatId, 'AI is not configured. Use /setai.')
      return
    }
    if (this.busy.has(chatId)) {
      await this.send(chatId, 'A session is already running — /cancel first.')
      return
    }
    this.lastBot.set(chatId, b.manifest.id)
    this.busy.add(chatId)
    await this.send(chatId, `🤖 ${allowWrites ? 'Working on' : 'Investigating'} <b>${escapeHtml(b.manifest.name)}</b>…`)
    const task = question || (allowWrites ? 'Diagnose any problems and fix them.' : 'Investigate the bot and report its health.')
    const thread = `bot:${b.manifest.id}` as const
    try {
      const result = await runAgent({
        provider: { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model },
        botId: b.manifest.id,
        dir: b.dir,
        task,
        allowWrites,
        maxSteps: allowWrites ? 20 : 12,
        history: getHistory(chatId, thread),
        events: {
          onText: (t) => {
            if (t.trim()) void this.send(chatId, escapeHtml(t))
          },
          onTool: (name, a) => {
            void this.send(chatId, `🔧 <i>${escapeHtml(name)}</i> ${escapeHtml(summarizeArgs(a))}`)
          },
          confirm: allowWrites ? (summary) => this.waitApproval(chatId, summary) : undefined
        }
      })
      appendTurn(chatId, thread, task, result)
      this.onChange?.()
      await this.send(chatId, '✅ Done.')
    } catch (e) {
      await this.send(chatId, `⚠️ Agent error: ${escapeHtml((e as Error).message?.split('\n')[0] ?? String(e))}`)
    } finally {
      this.busy.delete(chatId)
    }
  }

  // ---- direct AI chat with a live "cooking…" stream ----

  private async runChat(chatId: number, message: string): Promise<void> {
    const provider = getAgentConfig()
    if (!provider.ready) {
      await this.send(chatId, 'AI is not configured. Use /setai (or the app → Preferences → AI agent).')
      return
    }
    if (!message.trim()) {
      await this.send(chatId, 'Say something after “ai”, e.g. <code>ai what’s up?</code>')
      return
    }
    const placeholder = await this.sendReturn(chatId, pickCooking())
    const msgId = placeholder?.message_id
    let lastEdit = 0
    let lastShown = ''
    try {
      const full = await chatStream(
        { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model },
        [
          {
            role: 'system',
            content:
              'You are Sentinel, a friendly assistant that also helps the user run their Telegram bots. Keep replies concise and chatty. ' +
              'The conversation so far is included for context — remember what was said and refer back to it naturally. Use /reset to forget.'
          },
          ...getHistory(chatId, 'chat'),
          { role: 'user', content: message }
        ],
        (text) => {
          // Throttle edits to ~1/sec so we don't hit Telegram rate limits.
          const now = Date.now()
          if (msgId != null && now - lastEdit > 1100 && text !== lastShown) {
            lastEdit = now
            lastShown = text
            void this.edit(chatId, msgId, escapeHtml(clamp(text)) + ' ▌')
          }
        }
      )
      await this.edit(chatId, msgId, escapeHtml(clamp(full)) || '(no response)')
      appendTurn(chatId, 'chat', message, full)
    } catch (e) {
      await this.edit(chatId, msgId, `⚠️ ${escapeHtml((e as Error).message?.split('\n')[0] ?? String(e))}`)
    }
  }

  // ---- self-edit: let the agent change Sentinel's own source ----

  private async runSelfEdit(chatId: number, task: string): Promise<void> {
    const provider = getAgentConfig()
    if (!provider.ready) {
      await this.send(chatId, 'AI is not configured. Use /setai.')
      return
    }
    if (this.busy.has(chatId)) {
      await this.send(chatId, 'A session is already running — /cancel first.')
      return
    }
    let t = task.trim()
    if (!t) {
      const q = await this.askValue(chatId, '🛠 What change to <b>Sentinel’s own code</b> do you want? Describe it.')
      if (q == null || q === '') {
        await this.send(chatId, 'Cancelled.')
        return
      }
      t = q
    }
    this.busy.add(chatId)
    await this.send(
      chatId,
      '⚠️ <b>Editing Sentinel’s own source code.</b>\nEvery change needs your approval. When it finishes, rebuild/restart Sentinel (e.g. <code>npm run build</code>) to apply.'
    )
    try {
      const result = await runAgent({
        provider: { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model },
        botId: '__sentinel__',
        dir: SENTINEL_HOME,
        scope: 'self',
        task: t,
        allowWrites: true,
        maxSteps: 26,
        history: getHistory(chatId, 'self'),
        events: {
          onText: (x) => {
            if (x.trim()) void this.send(chatId, escapeHtml(x))
          },
          onTool: (name, a) => {
            void this.send(chatId, `🔧 <i>${escapeHtml(name)}</i> ${escapeHtml(summarizeArgs(a))}`)
          },
          confirm: (summary) => this.waitApproval(chatId, summary)
        }
      })
      appendTurn(chatId, 'self', t, result)
      this.onChange?.()
      await this.send(chatId, '✅ Done editing. Apply the changes now?', {
        inline_keyboard: [[{ text: '🔄 Rebuild & restart', callback_data: 'apply' }]]
      })
    } catch (e) {
      await this.send(chatId, `⚠️ Agent error: ${escapeHtml((e as Error).message?.split('\n')[0] ?? String(e))}`)
    } finally {
      this.busy.delete(chatId)
    }
  }

  /** Rebuild Sentinel (typecheck + build) and, on success, relaunch to apply. */
  private async runApply(chatId: number, confirm: boolean): Promise<void> {
    if (this.busy.has(chatId)) {
      await this.send(chatId, 'A session is already running — /cancel first.')
      return
    }
    if (confirm) {
      const ok = await this.waitApproval(chatId, 'Rebuild Sentinel and restart it now? The bot will drop for a few seconds.')
      if (!ok) {
        await this.send(chatId, 'Cancelled.')
        return
      }
    }
    this.busy.add(chatId)
    try {
      await this.send(chatId, '🔧 Type-checking & rebuilding…')
      const r = await exec('/bin/bash', ['-lc', 'npm run typecheck && npm run build'], {
        cwd: SENTINEL_HOME,
        timeout: 240_000,
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` }
      })
      if (r.code !== 0) {
        const tail = (r.stdout + r.stderr).split('\n').filter(Boolean).slice(-15).join('\n')
        await this.send(chatId, `⚠️ Build failed — <b>not</b> restarting:\n<pre>${escapeHtml(tail)}</pre>`)
        return
      }
      if (!this.restartApp) {
        await this.send(chatId, '✅ Rebuilt. (No restart hook here — restart Sentinel manually to apply.)')
        return
      }
      await this.send(chatId, '✅ Rebuilt. Restarting now — back in a few seconds. Send /status after.')
      // Let Telegram deliver the message before we exit the process.
      setTimeout(() => this.restartApp?.(), 800)
    } catch (e) {
      await this.send(chatId, `⚠️ ${escapeHtml((e as Error).message?.split('\n')[0] ?? String(e))}`)
    } finally {
      this.busy.delete(chatId)
    }
  }

  // ---- import a GitHub repo (public, or private with a token) ----

  private async runClone(chatId: number, url: string): Promise<void> {
    const isOwner = isAuthorized(chatId, this.getConfig().ownerChatId)
    if (!isOwner && botsOwnedBy(chatId).length >= getLimits().maxBotsPerTenant) {
      await this.send(chatId, '🚫 Bot limit reached for your account.')
      return
    }
    if (this.busy.has(chatId)) {
      await this.send(chatId, 'A session is already running — /cancel first.')
      return
    }
    this.busy.add(chatId)
    try {
      await this.send(chatId, `⬇️ Cloning <b>${escapeHtml(url)}</b>…`)
      let token: string | undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { bot, detect } = await sup.importBot({ type: 'git', source: url, token })
          setBotOwner(bot.manifest.id, chatId)
          this.onChange?.()
          this.lastBot.set(chatId, bot.manifest.id)
          await this.send(
            chatId,
            `✅ Imported <b>${escapeHtml(bot.manifest.name)}</b> from GitHub.\n${escapeHtml(detect.notes.join(' '))}\n\nNext: <b>/setup</b> to fill secrets, then ▶️ Start.`,
            botKeyboard(bot)
          )
          return
        } catch (e) {
          const msg = (e as Error).message ?? String(e)
          const authish = /authentication|could not read username|terminal prompts disabled|repository not found|403|fatal: could not read/i.test(msg)
          if (attempt === 0 && authish) {
            const tok = await this.askValue(
              chatId,
              '🔒 That repo looks private. Send a <b>GitHub access token</b> (I’ll delete your message right away), or /cancel.',
              { secret: true }
            )
            if (tok == null || tok === '') {
              await this.send(chatId, 'Cancelled — nothing imported.')
              return
            }
            token = tok
            await this.send(chatId, '⬇️ Retrying with your token…')
            continue
          }
          await this.send(chatId, `⚠️ Clone failed: ${escapeHtml(msg.split('\n')[0])}`)
          return
        }
      }
    } finally {
      this.busy.delete(chatId)
    }
  }

  // ---- push the bot's current state to a sentinel-live branch ----

  private async runPushLive(chatId: number, b: Bot): Promise<void> {
    if (b.manifest.source.type !== 'git') {
      await this.send(chatId, `<b>${escapeHtml(b.manifest.name)}</b> wasn’t imported from GitHub, so there’s no remote to push to.`)
      return
    }
    if (this.busy.has(chatId)) {
      await this.send(chatId, 'A session is already running — /cancel first.')
      return
    }
    this.lastBot.set(chatId, b.manifest.id)
    this.busy.add(chatId)
    try {
      // Use the stored GitHub token, or ask once and remember it (encrypted).
      let token = getGithubToken()
      if (!token) {
        const tok = await this.askValue(
          chatId,
          '🔑 Send a <b>GitHub token</b> with push access (I’ll delete your message and store it encrypted), or /cancel.',
          { secret: true }
        )
        if (tok == null || tok === '') {
          await this.send(chatId, 'Cancelled — nothing pushed.')
          return
        }
        token = tok
        setGithubToken(token)
      }
      await this.send(chatId, `⬆️ Pushing <b>${escapeHtml(b.manifest.name)}</b> → <code>sentinel-live</code>…`)
      const r = await sup.pushLive(b.manifest.id, () => {}, token)
      const link = r.url ? `\n<a href="${escapeHtml(r.url)}">View branch</a>` : ''
      await this.send(
        chatId,
        `✅ Pushed to <code>${escapeHtml(r.branch)}</code> (commit <code>${escapeHtml(r.commit.slice(0, 7))}</code>).${link}`
      )
    } catch (e) {
      // A bad stored token is the usual culprit — let the user re-enter it.
      const msg = (e as Error).message?.split('\n')[0] ?? String(e)
      if (/auth|403|denied|could not read|repository not found/i.test(msg)) setGithubToken('')
      await this.send(chatId, `⚠️ Push failed: ${escapeHtml(msg)}${/auth|403|denied/i.test(msg) ? '\nSend /push again to re-enter your token.' : ''}`)
    } finally {
      this.busy.delete(chatId)
    }
  }

  // ---- uploads: import a .zip as a bot, or add a file to a selected bot ----

  private async onDocument(msg: TgMessage, cfg: ControlConfig): Promise<void> {
    const chatId = msg.chat.id
    if (!isAuthorized(chatId, cfg.ownerChatId)) {
      await this.send(chatId, '⛔️ Not authorized.')
      return
    }
    const doc = msg.document
    if (!doc) return
    const fname = basename(doc.file_name || 'upload.bin')
    if ((doc.file_size ?? 0) > 19_000_000) {
      await this.send(chatId, '⚠️ That file is over ~20 MB (Telegram’s bot download limit). Use the app to import big projects.')
      return
    }
    const tmp = join(SENTINEL_HOME, '.uploads', `${Date.now()}_${fname}`)
    try {
      await this.send(chatId, `📥 Got <b>${escapeHtml(fname)}</b> — downloading…`)
      await this.downloadFile(doc.file_id, tmp)
      if (fname.toLowerCase().endsWith('.zip')) {
        await this.importZip(chatId, tmp, fname, msg.caption)
      } else {
        await this.addFileToBot(chatId, tmp, fname)
      }
    } catch (e) {
      await this.send(chatId, `⚠️ Upload failed: ${escapeHtml((e as Error).message?.split('\n')[0] ?? String(e))}`)
    } finally {
      try {
        if (existsSync(tmp)) rmSync(tmp)
      } catch {
        /* best effort */
      }
    }
  }

  /** Download a Telegram document to a local path via getFile + the file API. */
  private async downloadFile(fileId: string, destPath: string): Promise<void> {
    const info = await this.call<{ file_path?: string }>('getFile', { file_id: fileId })
    if (!info.file_path) throw new Error('could not resolve the file on Telegram')
    const res = await fetch(`${API}/file/bot${this.token}/${info.file_path}`)
    if (!res.ok) throw new Error(`download HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(dirname(destPath), { recursive: true })
    writeFileSync(destPath, buf)
  }

  /** Unzip an uploaded project and import it as a new managed bot. */
  private async importZip(chatId: number, zipPath: string, fname: string, caption?: string): Promise<void> {
    const name = (caption && caption.trim()) || fname.replace(/\.zip$/i, '')
    const extractDir = zipPath + '_x'
    mkdirSync(extractDir, { recursive: true })
    try {
      const r = await exec('/usr/bin/unzip', ['-o', '-q', zipPath, '-d', extractDir])
      if (r.code !== 0) throw new Error(`unzip failed: ${(r.stderr || r.stdout).slice(0, 200)}`)
      // If everything is inside one top-level folder, import that folder.
      let src = extractDir
      const entries = readdirSync(extractDir).filter((n) => n !== '__MACOSX' && !n.startsWith('.'))
      if (entries.length === 1 && statSync(join(extractDir, entries[0])).isDirectory()) {
        src = join(extractDir, entries[0])
      }
      await this.send(chatId, `📦 Importing <b>${escapeHtml(name)}</b> as a new bot…`)
      const { bot, detect } = await sup.importBot({ type: 'local', source: src, name })
      setBotOwner(bot.manifest.id, chatId)
      this.onChange?.()
      this.lastBot.set(chatId, bot.manifest.id)
      await this.send(
        chatId,
        `✅ Imported <b>${escapeHtml(bot.manifest.name)}</b>.\n${escapeHtml(detect.notes.join(' '))}\n\nNext: <b>/setup</b> to fill secrets, then ▶️ Start.`,
        botKeyboard(bot)
      )
    } finally {
      try {
        rmSync(extractDir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }

  /** Add a single uploaded file into the currently-selected bot's folder. */
  private async addFileToBot(chatId: number, filePath: string, fname: string): Promise<void> {
    const bots = await sup.listBots()
    const lastId = this.lastBot.get(chatId)
    const bot = (lastId ? bots.find((b) => b.manifest.id === lastId) : null) ?? (bots.length === 1 ? bots[0] : null)
    if (!bot) {
      await this.send(
        chatId,
        `To add <b>${escapeHtml(fname)}</b>, open a bot first (tap one below) then re-send the file. Or send a <b>.zip</b> to import a whole new bot.`,
        bots.length ? listKeyboard(bots) : undefined
      )
      return
    }
    const ok = await this.waitApproval(chatId, `Add file "${fname}" to ${bot.manifest.name}? It will be written into its folder (overwriting any existing copy).`)
    if (!ok) {
      await this.send(chatId, 'Cancelled.')
      return
    }
    copyFileSync(filePath, join(bot.dir, basename(fname)))
    this.onChange?.()
    await this.send(
      chatId,
      `✅ Added <code>${escapeHtml(basename(fname))}</code> to <b>${escapeHtml(bot.manifest.name)}</b>. Restart it to pick up code changes.`,
      botKeyboard(bot)
    )
  }

  private async registerCommands(): Promise<void> {
    await this.call('setMyCommands', {
      commands: [
        { command: 'status', description: 'Fleet overview' },
        { command: 'stats', description: 'Live CPU/memory per bot + totals' },
        { command: 'list', description: 'Pick a bot to control' },
        { command: 'logs', description: 'Recent log lines for a bot' },
        { command: 'update', description: 'Pull latest for a git bot' },
        { command: 'setenv', description: 'Set a secret (auto-deletes your message)' },
        { command: 'setup', description: 'AI-guided env setup (asks one by one)' },
        { command: 'ask', description: 'Ask the AI about a bot' },
        { command: 'fix', description: 'Let the AI fix a bot (you approve)' },
        { command: 'ai', description: 'Chat with the AI directly' },
        { command: 'dev', description: 'Edit Sentinel’s own code (advanced)' },
        { command: 'reset', description: 'Clear the AI’s conversation memory' },
        { command: 'push', description: 'Push a bot’s state to sentinel-live' },
        { command: 'apply', description: 'Rebuild & restart Sentinel (apply /dev)' },
        { command: 'upload', description: 'Import a .zip bot or add a file' },
        { command: 'clone', description: 'Import a GitHub repo as a new bot' },
        { command: 'yolo', description: 'Toggle auto-approve (skip prompts)' },
        { command: 'setai', description: 'Configure the AI provider' },
        { command: 'remove', description: 'Remove a bot (asks to confirm)' },
        { command: 'help', description: 'Show help' }
      ]
    }).catch(() => undefined)
  }

  // ---- Bot API plumbing ----

  private async send(chatId: number, text: string, keyboard?: Keyboard): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text: clamp(text),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard
    }).catch(() => undefined)
  }

  /** Like send(), but returns the created message so we can delete it later (prompts). */
  private async sendReturn(
    chatId: number,
    text: string,
    replyMarkup?: unknown
  ): Promise<{ message_id: number } | null> {
    return this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: clamp(text),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: replyMarkup
    }).catch(() => null)
  }

  private async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => undefined)
  }

  private async edit(chatId: number, messageId: number | undefined, text: string, keyboard?: ReplyMarkup): Promise<void> {
    if (messageId == null) return this.send(chatId, text, keyboard ?? undefined)
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: clamp(text),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard
      })
    } catch (e) {
      const m = String((e as Error).message || '')
      // "not modified" = the message already shows this — that's fine, not a failure.
      if (/not modified/i.test(m)) return
      // Genuinely uneditable (too old / deleted) → fall back to a fresh message.
      await this.send(chatId, text, keyboard ?? undefined)
    }
  }

  private async answer(callbackId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, text }).catch(() => undefined)
  }

  private async call<T = any>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    let text: string
    try {
      const res = await fetch(`${API}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal
      })
      text = await res.text()
    } catch {
      text = await postTelegramJson(this.token, method, params, signal)
    }
    const json = JSON.parse(text) as { ok: boolean; result?: T; description?: string }
    if (!json.ok) throw new Error(json.description ?? `Telegram ${method} failed`)
    return json.result as T
  }
}

// ---- formatting that needs Bot detail --------------------------------------

function botDetail(b: Bot, live?: ProcStat | null): string {
  const r = b.runtime
  const cpuV = live?.cpu ?? r.cpu
  const memV = live?.memMB ?? r.memMB
  const memPctV = live?.memPct ?? r.memPct
  const upV = live?.uptime ?? r.uptime
  const cpu = cpuV != null ? `${cpuV.toFixed(1)}%` : '—'
  const mem = memV != null ? `${memV} MB${memPctV != null ? ` (${memPctV}% of RAM)` : ''}` : '—'
  return [
    `${statusEmoji(r.status)} <b>${escapeHtml(b.manifest.name)}</b>`,
    `Status: <b>${r.status}</b>${r.pid ? ` · pid ${r.pid}` : ''}${upV ? ` · up ${upV}` : ''}`,
    `CPU ${cpu} · Mem ${mem}`,
    `Env: ${r.envReady ? 'ready' : 'not set up'} · agent: ${r.installed ? 'installed' : 'off'}`,
    r.restarts ? `Restarts: ${r.restarts}` : '',
    `<i>updated ${new Date().toLocaleTimeString()}</i>`
  ]
    .filter(Boolean)
    .join('\n')
}

function logsBlock(b: Bot): string {
  return `📄 <b>${escapeHtml(b.manifest.name)}</b> — last lines:\n<pre>${escapeHtml(tailBotLogs(b.manifest.id))}</pre>`
}

function clamp(s: string): string {
  return s.length > MAX_MSG ? s.slice(0, MAX_MSG) + '\n…(truncated)' : s
}

/** Compact one-line view of a tool call's args for progress messages. */
function summarizeArgs(a: Record<string, unknown>): string {
  const s = JSON.stringify(a)
  if (s === '{}') return ''
  return s.length > 140 ? s.slice(0, 140) + '…' : s
}

const COOKING = [
  '🍳 Claude’s cooking…',
  '🧠 Thinking…',
  '⚙️ Crunching…',
  '✨ Conjuring…',
  '🔮 Pondering…',
  '🛰️ Computing…',
  '📡 Brewing a reply…',
  '🤔 Let me think…'
]

/** A random fun "working on it" placeholder shown before the stream starts. */
function pickCooking(): string {
  return COOKING[Math.floor(Math.random() * COOKING.length)]
}

/**
 * If a message is (just) a GitHub/GitLab/Bitbucket repo link, return a clean
 * https clone URL; otherwise null. Anchored so URLs mid-sentence don't trigger.
 */
export function gitUrlFrom(text: string): string | null {
  const t = text.trim()
  if (/^git@/i.test(t)) return null // ssh needs keys — not supported here
  const m = t.match(/^(?:https?:\/\/)?(?:www\.)?((?:github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i)
  if (m) return 'https://' + m[1]
  if (/^https:\/\/\S+\.git$/i.test(t)) return t
  return null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
