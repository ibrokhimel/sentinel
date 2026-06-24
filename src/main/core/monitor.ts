/**
 * Background supervision loop. launchd keeps a bot *running*; the monitor adds
 * the app-level judgment launchd lacks: give up on a crash-looping bot (launchd
 * restarts forever), notify the owner on crashes, and run scheduled GitHub
 * auto-updates with rollback. Runs both inside the GUI (while open) and inside
 * the headless `--agent` process (always on).
 */
import type { Bot } from '@shared/types'
import * as sup from './supervisor'
import * as launchctl from './launchctl'
import { notifyOwner, notifyOwnerWithButtons } from './notify'
import { getAppConfig } from './config'
import { refreshUpdateCounts, getUpdatesBehind, clearUpdatesBehind } from './updates'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DATA_HOME } from './paths'

/** One CPU/memory sample for a bot, taken each monitor tick. */
export interface MetricSample {
  ts: number
  cpu: number | null
  memMB: number | null
  memPct: number | null
}

const METRICS_CAP = 120
/** Module-level per-bot ring buffer so the Mini App route can read live samples. */
const metricsStore = new Map<string, MetricSample[]>()

/** Append a sample for a bot, capping the buffer at METRICS_CAP. */
function pushMetric(botId: string, s: MetricSample): void {
  let buf = metricsStore.get(botId)
  if (!buf) {
    buf = []
    metricsStore.set(botId, buf)
  }
  buf.push(s)
  if (buf.length > METRICS_CAP) buf.splice(0, buf.length - METRICS_CAP)
}

/** Return the last `n` samples for a bot (default 60). */
export function getMetrics(botId: string, n = 60): MetricSample[] {
  const buf = metricsStore.get(botId)
  if (!buf) return []
  const count = Math.min(Math.max(1, n), buf.length)
  return buf.slice(buf.length - count)
}

// ---- per-bot mute state for crash alerts (persisted so a mute survives restart) ----
const MUTE_FILE = join(DATA_HOME, 'crash-mutes.json')

function loadMutes(): [string, number][] {
  try {
    const obj = JSON.parse(readFileSync(MUTE_FILE, 'utf8')) as Record<string, number>
    const now = Date.now()
    return Object.entries(obj).filter(([, until]) => until > now)
  } catch {
    return []
  }
}
function saveMutes(): void {
  try {
    const now = Date.now()
    const obj: Record<string, number> = {}
    for (const [id, until] of muteUntil) if (until > now) obj[id] = until
    mkdirSync(dirname(MUTE_FILE), { recursive: true })
    writeFileSync(MUTE_FILE, JSON.stringify(obj))
  } catch {
    /* best-effort: a failed persist must never break supervision */
  }
}

const muteUntil = new Map<string, number>(loadMutes())

/** Mute crash notifications for a bot for `ms` milliseconds from now. */
export function muteBot(id: string, ms: number): void {
  muteUntil.set(id, Date.now() + ms)
  saveMutes()
}

/** True if a bot's crash notifications are currently muted. */
export function isMuted(id: string): boolean {
  const until = muteUntil.get(id)
  return until != null && until > Date.now()
}

interface BotState {
  status: string
  /** ms timestamp of the last auto-update we triggered (for rollback window). */
  lastUpdateTs?: number
  /** ms timestamp of the last update *check*. */
  lastCheckTs?: number
  /** crash-loop already actioned for this run, to avoid repeated notifications. */
  handledLoop?: boolean
  /** crash notification already sent for the current crashed run, to avoid spam. */
  handledCrash?: boolean
  /** disabled-in-launchd recovery already actioned, to avoid repeat notifications. */
  handledDisabled?: boolean
  /** count of last-notified update count, so we DM once per new batch of updates. */
  notifiedUpdatesBehind?: number
  /** consecutive ticks this bot has been over a resource threshold. */
  resourceBreachStreak?: number
  /** high-resource alert already sent for the current breach, to avoid spam. */
  notifiedResource?: boolean
}

const ROLLBACK_WINDOW_MS = 3 * 60 * 1000

// ---- update-available nudges ----
/** Refresh the network-backed commits-behind counts at most this often. */
const UPDATE_REFRESH_INTERVAL_MS = 30 * 60 * 1000

// ---- resource-threshold alerts ----
/** CPU percent of one core at/above which a running bot is "hot". */
const CPU_ALERT_PCT = 90
/** Memory percent of total RAM at/above which a running bot is "heavy". */
const MEM_ALERT_PCT = 80
/** Consecutive over-threshold ticks before alerting (rides out transient spikes). */
const RESOURCE_BREACH_TICKS = 3

export class MonitorService {
  private timer: ReturnType<typeof setInterval> | null = null
  private state = new Map<string, BotState>()
  private running = false
  /** ms timestamp of the last network update-count refresh (throttled cadence). */
  private lastUpdateRefreshTs = 0

  constructor(
    private opts: { intervalMs?: number; onChange?: () => void } = {}
  ) {}

  start(): void {
    if (this.timer) return
    const ms = this.opts.intervalMs ?? 30_000
    this.timer = setInterval(() => void this.tick(), ms)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One supervision pass over all bots. Errors per-bot are swallowed. */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const bots = await sup.listBots()
      const live = new Set<string>()
      const now = Date.now()
      for (const bot of bots) {
        const id = bot.manifest.id
        live.add(id)
        // Sample CPU/mem from the runtime the supervisor already computed —
        // no extra `ps` spawns here.
        pushMetric(id, {
          ts: now,
          cpu: bot.runtime.cpu ?? null,
          memMB: bot.runtime.memMB ?? null,
          memPct: bot.runtime.memPct ?? null
        })
        try {
          await this.handle(bot)
        } catch {
          /* never let one bot break the loop */
        }
      }
      // Prune metric buffers for bots that no longer exist.
      for (const id of metricsStore.keys()) {
        if (!live.has(id)) metricsStore.delete(id)
      }
      // Throttled network refresh of "commits behind" counts + new-update DMs.
      await this.maybeRefreshUpdates(bots, now)
    } finally {
      this.running = false
    }
  }

  /**
   * On a throttled cadence, hit the network to recompute how far behind origin
   * each git bot is, then DM the owner ONCE when a bot gains new updates (count
   * rises from 0/unknown to >0, or climbs to a higher count). The DM carries the
   * same callbacks the control bot already handles (do:update / logs).
   */
  private async maybeRefreshUpdates(bots: Bot[], now: number): Promise<void> {
    if (now - this.lastUpdateRefreshTs < UPDATE_REFRESH_INTERVAL_MS) return
    this.lastUpdateRefreshTs = now

    await refreshUpdateCounts(bots).catch(() => undefined)

    for (const bot of bots) {
      if (bot.manifest.source.type !== 'git') continue
      const id = bot.manifest.id
      const st = this.state.get(id) ?? { status: bot.runtime.status }
      const behind = getUpdatesBehind(id) ?? 0
      const lastNotified = st.notifiedUpdatesBehind ?? 0

      // New updates appeared (or grew) since we last told the owner about them.
      // notifyOwnerWithButtons itself respects the global notify-enabled config.
      const shouldNotify =
        behind > 0 &&
        behind > lastNotified &&
        bot.manifest.notifyOnCrash !== false &&
        !isMuted(id)

      if (shouldNotify) {
        await notifyOwnerWithButtons(
          `"${bot.manifest.name}" has ${behind} update${behind === 1 ? '' : 's'} available.`,
          {
            inline_keyboard: [
              [{ text: '⬇️ Update now', callback_data: `do:update:${id}` }],
              [{ text: '📄 Logs', callback_data: `logs:${id}` }]
            ]
          }
        )
      }

      // Track the count we last notified for so we don't re-nudge every cycle;
      // reset to 0 when the bot is up to date so a future update fires again.
      st.notifiedUpdatesBehind = behind > 0 ? behind : 0
      this.state.set(id, st)
    }
  }

  private async handle(bot: Bot): Promise<void> {
    const id = bot.manifest.id
    const prev = this.state.get(id) ?? { status: bot.runtime.status }
    const next: BotState = { ...prev, status: bot.runtime.status }

    // --- crash-loop: launchd won't stop; we do. ---
    if (bot.runtime.status === 'crash-looping' && !prev.handledLoop) {
      next.handledLoop = true
      const wasJustUpdated = prev.lastUpdateTs && Date.now() - prev.lastUpdateTs < ROLLBACK_WINDOW_MS
      if (wasJustUpdated && bot.manifest.lastGoodSha) {
        await sup.rollbackBot(id, bot.manifest.lastGoodSha, () => {}).catch(() => undefined)
        await notifyOwner(`"${bot.manifest.name}" crash-looped after an update — rolled back to ${bot.manifest.lastGoodSha?.slice(0, 8)}.`)
      } else {
        await sup.giveUp(id).catch(() => undefined)
        await notifyOwner(`Stopped "${bot.manifest.name}" — it was crash-looping (> ${bot.manifest.maxRestarts} restarts). Check its logs.`)
      }
      this.opts.onChange?.()
    } else if (bot.runtime.status !== 'crash-looping') {
      next.handledLoop = false
    }

    // --- crash notification on the running -> crashed transition ---
    // Only fire once per crashed run (track handledCrash like handledLoop), skip
    // when the owner muted this bot, and attach inline actions so the alert is
    // actionable straight from the push notification.
    if (bot.runtime.status === 'crashed') {
      const justCrashed = prev.status === 'running'
      if (
        justCrashed &&
        !prev.handledCrash &&
        bot.manifest.notifyOnCrash !== false &&
        !isMuted(id)
      ) {
        next.handledCrash = true
        await notifyOwnerWithButtons(
          `"${bot.manifest.name}" crashed (exit code ${bot.runtime.lastExitCode}).`,
          {
            inline_keyboard: [
              [{ text: '🔁 Restart', callback_data: `do:restart:${id}` }],
              [{ text: '📄 Logs', callback_data: `logs:${id}` }],
              [{ text: '🔕 Mute 1h', callback_data: `mute:${id}` }]
            ]
          }
        )
      } else if (justCrashed) {
        // Suppressed (muted / opted out / already handled) but still a fresh
        // crash — mark it handled so we don't re-evaluate every tick.
        next.handledCrash = true
      }
    } else {
      next.handledCrash = false
    }

    // --- resource-threshold alert: sustained high CPU or memory ---
    // Only watch running bots. Require N consecutive over-threshold ticks before
    // alerting so a transient spike doesn't page the owner, and only fire once
    // per breach (reset when it drops back under so it can fire again later).
    if (bot.runtime.status === 'running') {
      const cpu = bot.runtime.cpu ?? 0
      const memPct = bot.runtime.memPct ?? 0
      const over = cpu >= CPU_ALERT_PCT || memPct >= MEM_ALERT_PCT
      if (over) {
        next.resourceBreachStreak = (prev.resourceBreachStreak ?? 0) + 1
        if (
          next.resourceBreachStreak >= RESOURCE_BREACH_TICKS &&
          !prev.notifiedResource &&
          bot.manifest.notifyOnCrash !== false &&
          !isMuted(id)
        ) {
          next.notifiedResource = true
          const metric =
            cpu >= CPU_ALERT_PCT ? `high CPU (${Math.round(cpu)}%)` : `high memory (${Math.round(memPct)}%)`
          await notifyOwnerWithButtons(`⚠️ "${bot.manifest.name}" ${metric} for a few minutes.`, {
            inline_keyboard: [[{ text: '📄 Logs', callback_data: `logs:${id}` }]]
          })
        }
      } else {
        // Back under threshold: clear the streak + arm the alert to fire again.
        next.resourceBreachStreak = 0
        next.notifiedResource = false
      }
    } else {
      next.resourceBreachStreak = 0
      next.notifiedResource = false
    }

    // --- self-heal: a keep-alive bot left "disabled" in launchd can't restart ---
    // launchd's disabled override defeats both KeepAlive and RunAtLoad, so the
    // bot stays down forever with no crash to notify on. Sentinel never disables
    // services, and a normal Stop uses bootout (which does NOT set this flag), so
    // gating recovery on the disabled flag never fights the Stop button.
    if (this.shouldKeepUp(bot) && bot.runtime.status !== 'running' && bot.runtime.status !== 'crash-looping') {
      if (!prev.handledDisabled && (await launchctl.isDisabled(id).catch(() => false))) {
        next.handledDisabled = true
        await sup.start(id).catch(() => undefined) // start() now enables + bootstraps
        await notifyOwner(`Recovered "${bot.manifest.name}" — it was disabled in launchd and couldn't auto-restart.`)
        this.opts.onChange?.()
      }
    } else if (bot.runtime.status === 'running') {
      next.handledDisabled = false
    }

    // --- scheduled GitHub auto-update ---
    await this.maybeAutoUpdate(bot, next)

    this.state.set(id, next)
  }

  /** A bot whose declared intent is "always running on this machine". */
  private shouldKeepUp(bot: Bot): boolean {
    const m = bot.manifest
    return !m.schedule && m.restartPolicy === 'always' && m.autostart === true
  }

  private async maybeAutoUpdate(bot: Bot, st: BotState): Promise<void> {
    const cfg = getAppConfig()
    if (!cfg.autoUpdateEnabled || !bot.manifest.autoUpdate) return
    if (bot.manifest.source.type !== 'git') return

    const intervalMs = (bot.manifest.updateIntervalHours ?? 6) * 3600_000
    if (st.lastCheckTs && Date.now() - st.lastCheckTs < intervalMs) return
    st.lastCheckTs = Date.now()

    const check = await sup.checkUpdates(bot.manifest.id).catch(() => null)
    if (!check || !check.isGit || check.behind <= 0) return

    st.lastUpdateTs = Date.now()
    await notifyOwner(`Updating "${bot.manifest.name}" (${check.behind} commit(s) behind)…`)
    try {
      await sup.updateBot(bot.manifest.id, () => {})
      // We're now up to date — clear the cached count and re-arm update nudges.
      clearUpdatesBehind(bot.manifest.id)
      st.notifiedUpdatesBehind = 0
      await notifyOwner(`"${bot.manifest.name}" updated to the latest commit.`)
    } catch (e) {
      await notifyOwner(`Auto-update of "${bot.manifest.name}" failed: ${(e as Error).message.split('\n')[0]}`)
    }
    this.opts.onChange?.()
  }
}
