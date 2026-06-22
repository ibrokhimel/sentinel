# Sentinel

A macOS app that lets you **import your bots/scripts/apps and keeps them running in the background** — auto-restart on crash, logs, status, and a clean GUI. Think a friendly Mac front-end for a process manager (`pm2` / `launchd`), built for personal use.

This file is a handoff doc. A new Claude session will be launched in `~/Documents/Sentinel` to build it.

---

## Conversation so far (context for the next session)

- User wants an app to "import my apps or bots" and have them **automatically run in the background** on this Mac, with a **nice interface** and room to grow ("and more").
- We discussed names; user chose **Sentinel**.
- User's environment: macOS (Darwin 25.4.0), Mac mini. Email: adrianmid98@gmail.com.
- Related existing projects on this machine:
  - **WatcherDogBot** — a Telegram bot-monitoring tool at `~/Documents/WatcherDogBot` (built, awaiting MTProto login).
  - **telegram-mcp** — `chigwell/telegram-mcp` at `~/Documents/telegram-mcp` for full account control.
- These are likely the first "bots" the user will import into Sentinel, so Sentinel should handle **Python bots** well (both above are Python/Telegram tools).

---

## What Sentinel actually is (scope)

A **process supervisor with a GUI**. Core job:
1. **Import** a bot/script/app (pick a folder + entry command, e.g. `python main.py`).
2. **Run** it as a managed background process.
3. **Keep it alive** — restart on crash, with backoff.
4. **Observe** — live status (running/stopped/crashed), CPU/mem, captured stdout/stderr logs.
5. **Control** — start / stop / restart per bot, enable/disable autostart-on-login.

"And more" later: scheduling, notifications on crash, env-var/secrets management, resource limits, grouping, remote view from phone.

---

## Architecture options (pick one in the build session)

### Option A — Tauri (Rust core + web UI)  ⭐ recommended
- **Why:** tiny binary, native-feeling, real OS process control in Rust, modern web UI (React/Svelte) for the "nice interface." Good long-term foundation.
- **Process model:** Rust spawns/monitors child processes (`std::process` / `tokio`), supervises restarts, streams logs to the UI over Tauri events.
- **Autostart-on-login:** `tauri-plugin-autostart` + per-bot `launchd` plist generation.
- **Cost:** need some Rust. Steeper but cleanest.

### Option B — Electron (Node core + web UI)
- **Why:** fastest to a polished UI, huge ecosystem, can literally wrap/extend `pm2` (Node-native process manager) for the supervise/restart/log logic.
- **Process model:** Node `child_process` or embed `pm2` programmatically (`pm2.start/stop/list/logs`).
- **Cost:** heavier binary (~150MB), but lowest friction to ship something working today.

### Option C — Native SwiftUI
- **Why:** most "Mac-native" look, smallest footprint, best menu-bar integration.
- **Process model:** `Process` API + `launchd` for persistence.
- **Cost:** Swift only, more UI work for log streaming; least cross-platform.

**Recommendation:** Start with **Electron + pm2** for a working v1 fast (since the bots are Python and pm2 supervises any command), or **Tauri** if the user wants a lean, lasting native app. Decide with the user at session start.

---

## Core data model

```jsonc
// One managed bot
{
  "id": "uuid",
  "name": "WatcherDogBot",
  "cwd": "/Users/macmini4/Documents/WatcherDogBot",
  "command": "python",
  "args": ["main.py"],
  "env": { "API_ID": "...", "API_HASH": "..." },  // stored in macOS Keychain, not plaintext
  "autostart": true,        // start when Sentinel launches / on login
  "restartPolicy": "on-crash", // always | on-crash | never
  "maxRestarts": 10,
  "status": "running",      // running | stopped | crashed | starting
  "pid": 12345,
  "createdAt": "...",
  "lastExitCode": null
}
```

- Config stored at `~/Library/Application Support/Sentinel/bots.json`.
- Logs at `~/Library/Application Support/Sentinel/logs/<bot-id>.log` (rotated).
- Secrets/env in **macOS Keychain**, referenced by id — never in `bots.json`.

---

## Feature roadmap

### v1 (MVP) — get one bot running reliably
- [ ] Add bot: folder picker + command + args.
- [ ] Start / stop / restart a bot.
- [ ] Auto-restart on crash (with exponential backoff).
- [ ] Live status list + per-bot log viewer (tail stdout/stderr).
- [ ] Persist bots across app restarts.
- [ ] Import WatcherDogBot as the first real test.

### v2 — polish & persistence
- [ ] Autostart-on-login (launchd) so bots run even if app/Mac restarts.
- [ ] Env-var / secrets editor backed by Keychain.
- [ ] Menu-bar icon with quick status + start/stop.
- [ ] Crash notifications (native macOS notification).
- [ ] CPU / memory per bot.

### v3 — "and more"
- [ ] Scheduling (run at times / cron).
- [ ] Detect bot type (Python venv, Node, shell) and auto-suggest command.
- [ ] Per-bot venv / dependency setup helper.
- [ ] Grouping & tags, search.
- [ ] Optional remote view (web/phone) of status.

---

## Key technical risks / notes

- **True background persistence:** if Sentinel (the app) is quit, child processes die unless registered with `launchd`. For "always running even after reboot," each autostart bot needs a generated `launchd` LaunchAgent plist in `~/Library/LaunchAgents/`. Decide: bots tied to app lifetime (simpler) vs. fully independent via launchd (more robust).
- **Python bots need their environment:** must capture the right interpreter (venv path, e.g. `WatcherDogBot/.venv/bin/python`) not just `python`. Add a venv-aware launch.
- **Log streaming:** stream incrementally to UI; rotate/cap log files to avoid disk bloat.
- **Permissions:** spawning processes is fine; if bots need network/full-disk, that's the bot's concern, not Sentinel's.
- **Secrets:** keep API keys out of the JSON config — Keychain.

---

## Suggested first steps for the build session

1. Confirm stack with user (recommend **Electron + pm2** for speed, or **Tauri** for a lean native app).
2. Scaffold the project in this folder (`~/Documents/Sentinel`).
3. Build v1 MVP: add/start/stop/restart + auto-restart + log tail + persistence.
4. Import `~/Documents/WatcherDogBot` as the first managed bot and verify it stays alive.
5. Then layer in launchd autostart and the menu-bar UI.

---

*Generated 2026-06-16. Folder: `~/Documents/Sentinel`.*
