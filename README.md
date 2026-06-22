# Sentinel

A macOS app that keeps your Telegram bots running **24/7** — surviving crashes
and reboots — with a clean GUI. It's a friendly front-end over `launchd`: you
import a bot, Sentinel sets up its Python environment, collects its secrets,
walks you through the one-time Telegram login, and installs a per-bot launchd
LaunchAgent that keeps it alive.

Your bot files live inside `~/Documents/Sentinel/bots/`.

## Why launchd (not pm2)

pm2's reboot-persistence on macOS is unreliable. `launchd` is the OS-native
supervisor: `KeepAlive` restarts a bot on crash and `RunAtLoad` starts it at
login/boot. Bots run **independently of this app** — quit Sentinel and they keep
running. See `PLAN.md` for the full rationale and research.

## Run it

```bash
npm install        # also rebuilds the pty native module for Electron
npm run dev         # launch in development
```

Build a local `.app` (ad-hoc signed — no Apple Developer account needed):

```bash
npm run package     # outputs dist/Sentinel-*.dmg and dist/mac*/Sentinel.app
```

## Using it

1. **Import** — “+ Import bot”, pick a **local folder** or paste a **GitHub URL**
   (private repos take a token). Files are copied into `bots/<name>/` and
   Sentinel auto-detects the package manager and entry point, writing a
   `sentinel.json` manifest (editable in the Settings tab).
2. **Set up environment** — creates `.venv` and installs dependencies
   (`venv`/`uv`/`poetry`/`pipenv`).
3. **Secrets** — fill the `.env` form (seeded from the repo's `.env.example`);
   written `chmod 600`.
4. **First-time Telegram login** — runs the bot in an embedded terminal so
   Telethon's phone-number/code prompts work and the `.session` file is created.
   (Falls back to opening Terminal.app if the embedded terminal is unavailable.)
5. **Start 24/7** — installs the launchd agent. The bot is now running and
   self-healing.

### Going further (Preferences ⚙︎)

- **Telegram crash alerts** — create a bot with @BotFather, paste its token + your chat
  id; Sentinel DMs you when a bot crashes or crash-loops. The token is encrypted with
  macOS `safeStorage`.
- **Telegram remote control** — the *same* bot accepts commands from your chat:
  `/status`, `/list`, `/logs <bot>`, `/update <bot>`, and inline Start/Stop/Restart
  buttons. Manage your fleet from your phone.
- **GitHub auto-update** — per-bot toggle + global switch: pulls on a schedule, reinstalls
  deps only if they changed, restarts on the new code, and rolls back if it crash-loops.
- **Always-on background agent** — installs a headless launchd agent so crash-loop
  give-up, alerts, and auto-update keep working even when the window is closed.
- **Per-bot**: schedule (always-on / every N min / daily), tags, CPU/mem, framework.

### Surviving a reboot

A LaunchAgent only runs after a login. To have bots come back automatically
after the Mac restarts with no one present, enable **auto-login**
(System Settings → Users & Groups → Automatically log in as your user). Sentinel
shows a banner and a shortcut to the setting when this is needed. FileVault must
be off for auto-login (it already is on this machine).

## Where things live

```
~/Documents/Sentinel/
  bots/<name>/            imported bot + .venv + .env + .session + sentinel.json
  logs/<id>.out.log       launchd stdout
  logs/<id>.err.log       launchd stderr
  registry.json           list of managed bots (no secrets)
~/Library/LaunchAgents/com.sentinel.<id>.plist   the per-bot launchd agent
```

## Project layout

```
src/main/         Electron main process + IPC
src/main/core/    supervisor core (detect, venv, git, plist, launchctl, login, …)
src/preload/      contextBridge API exposed as window.sentinel
src/renderer/     React UI
src/shared/       types + IPC contract shared across all three
```

## Tests

```bash
npm test                                  # pure unit tests (detect, plist, env, launchspec)
SENTINEL_INTEGRATION=1 npm test           # also runs the real launchd lifecycle test
```

The integration test creates a throwaway venv + LaunchAgent, verifies crash
auto-restart, then cleans up. It's verified working on macOS 26.4.
