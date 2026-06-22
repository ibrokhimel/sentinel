/**
 * Notifications. The primary channel is Telegram itself — since the things we
 * supervise are Telegram bots, DMing the owner works even when the Mac's screen
 * is off and the GUI is closed (when sent from the background agent). A native
 * macOS notification is also fired when a window is available.
 */
import { getNotifyConfig } from './config'

/** Send a Telegram message via the Bot API. Returns true on success. */
export async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Notify the owner of an event, using the configured Telegram notifier if set.
 * Safe to call from anywhere; silently no-ops if notifications are disabled or
 * unconfigured.
 */
export async function notifyOwner(message: string): Promise<void> {
  const cfg = getNotifyConfig()
  if (!cfg.enabled || !cfg.token || !cfg.chatId) return
  await sendTelegram(cfg.token, cfg.chatId, `🛰️ Sentinel: ${message}`)
}
