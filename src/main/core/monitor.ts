/**
 * Background supervision loop. launchd keeps a bot *running*; the monitor adds
 * the app-level judgment launchd lacks: give up on a crash-looping bot (launchd
 * restarts forever), notify the owner on crashes, and run scheduled GitHub
 * auto-updates with rollback. Runs both inside the GUI (while open) and inside
 * the headless `--agent` process (always on).
 */
import type { Bot } from '@shared/types'
import * as sup from './supervisor'
import { notifyOwner } from './notify'
import { getAppConfig } from './config'

interface BotState {
  status: string
  /** ms timestamp of the last auto-update we triggered (for rollback window). */
  lastUpdateTs?: number
  /** ms timestamp of the last update *check*. */
  lastCheckTs?: number
  /** crash-loop already actioned for this run, to avoid repeated notifications. */
  handledLoop?: boolean
}

const ROLLBACK_WINDOW_MS = 3 * 60 * 1000

export class MonitorService {
  private timer: ReturnType<typeof setInterval> | null = null
  private state = new Map<string, BotState>()
  private running = false

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
      for (const bot of bots) {
        try {
          await this.handle(bot)
        } catch {
          /* never let one bot break the loop */
        }
      }
    } finally {
      this.running = false
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

    // --- crash notification on running -> crashed transition ---
    if (
      bot.runtime.status === 'crashed' &&
      prev.status === 'running' &&
      bot.manifest.notifyOnCrash !== false
    ) {
      await notifyOwner(`"${bot.manifest.name}" crashed (exit code ${bot.runtime.lastExitCode}).`)
    }

    // --- scheduled GitHub auto-update ---
    await this.maybeAutoUpdate(bot, next)

    this.state.set(id, next)
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
      await notifyOwner(`"${bot.manifest.name}" updated to the latest commit.`)
    } catch (e) {
      await notifyOwner(`Auto-update of "${bot.manifest.name}" failed: ${(e as Error).message.split('\n')[0]}`)
    }
    this.opts.onChange?.()
  }
}
