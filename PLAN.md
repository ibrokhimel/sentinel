# Sentinel — Build Plan

> Planning artifact for the build session. Researched & written 2026-06-16.
> Companion to `SENTINEL.md` (the original handoff). Where the two disagree, **this file wins** — it reflects research done after the handoff.

---

## 0. The actual goal (narrowed)

> "I just need it for running my Telegram bots live 24/7. That's all. And it should keep the bot files inside this folder too."

So Sentinel is **a GUI control panel that makes my Telegram bots run forever on this Mac mini** — surviving crashes *and* reboots — with their files living under `~/Documents/Sentinel/`. Everything else in the original roadmap is secondary.

Three real bots are the test set:
- **WatcherDogBot** (`~/Documents/WatcherDogBot`) — Python 3.9, `.venv/bin/python`, entry `run_watcher.py`, Telethon user-account + a BotFather bot, secrets in `.env`, MTProto `.session`.
- **telegram-mcp** (`~/Documents/telegram-mcp`) — Python 3.13 via **uv**, `.venv/bin/python`, entry `main.py`, Telethon, secrets in `.env`.
- (room for a third / more.)

---

## 1. THE key decision: launchd is the supervisor, not pm2  ✅ CONFIRMED 2026-06-16

The original handoff said "Electron + pm2." **Decision (user-confirmed): drop pm2 and use macOS `launchd` for both supervision and boot-persistence.** Electron stays — only as the GUI.

**Why pm2 is the wrong tool here:**
- pm2's boot-persistence on macOS is documented-broken: `pm2 startup` frequently fails with *"Init system not found"* / *"launchctl: command not found"*, and even when its plist installs it often *doesn't run on boot*. (PM2 issues #5084, #5193, #4318, #2617.) The "fix" everyone lands on is a **hand-written launchd plist that runs `pm2 resurrect`** — i.e. pm2 reduces to launchd anyway, with an extra fragile layer.
- It stacks two supervisors: launchd must start pm2, pm2 must resurrect a saved dump. More moving parts, more failure modes.

**Why launchd is right:**
- It's the OS-native supervisor. `KeepAlive` restarts a bot on crash; `RunAtLoad` starts it at login/boot; logs go straight to files via `StandardOutPath`/`StandardErrorPath`.
- **It's already what these bots were built for** — WatcherDogBot ships `com.watcherdog.*.plist` with `KeepAlive=true` + `RunAtLoad=true`. We're formalizing a pattern that already exists on this machine (it was just never installed).
- Bots run **independently of the Sentinel app** — quit the GUI, the bots keep running. That is exactly what "24/7" requires. The GUI becomes a true control panel, not a parent process the bots die with.

**launchd limitations to design around:**
- **No exponential backoff.** launchd respawns at a fixed `ThrottleInterval` (min/default **10s**). A crash-looping bot restarts every 10s forever — launchd never gives up. → Sentinel watches restart counts (via `launchctl print`) and surfaces "crash-looping" + can auto-`bootout` after N restarts (app-level backoff).
- `KeepAlive: true` restarts even on *intentional* stop. To truly stop a bot you `bootout` (unload) its agent; to start, `bootstrap`. (Details in §4.)

---

## 2. THE other key decision: how it survives a reboot  ✅ CONFIRMED 2026-06-16 — LaunchAgent + auto-login

This is the crux of "run when the Mac turns off and on." A macOS `launchd` job is either a **LaunchAgent** or a **LaunchDaemon**, and they behave very differently across reboot:

| | **LaunchAgent** (`~/Library/LaunchAgents`) | **LaunchDaemon** (`/Library/LaunchDaemons`) |
|---|---|---|
| Runs as | your user | **root** (set `UserName` to drop to you) |
| Starts | only **after a GUI login** | at **boot, no login needed** |
| User Keychain / session | available | **not** available |
| Venv/file permissions | clean (your home, your user) | messy (root touching `~/...`) |
| Survives unattended reboot | **only if auto-login is ON** | always |

**This machine right now:** macOS **26.4**, **FileVault OFF**, **auto-login NOT set**. FileVault-off is what makes auto-login possible (they're mutually exclusive).

**Recommendation: LaunchAgent + enable auto-login.** Reasoning:
- Bots run as *you*, in your home, reading their own `.env`/`.session` — zero permission/root headaches, and your Keychain is reachable if we later store secrets there.
- The only cost is flipping on **System Settings → Users & Groups → Automatically log in as `macmini4`** (one toggle; FileVault is already off, so no conflict). After that, every boot establishes your session → every LaunchAgent with `RunAtLoad` comes up → bots are live with no human present.
- LaunchDaemon-as-root is the textbook "headless 24/7" answer but is overkill and more fragile for *personal* Python bots that want a user context.

**macOS 26 caveat to verify in the build:** since macOS 13, Background Task Management can flag third-party `launchd` jobs as "legacy," and the modern path is registering them via **`SMAppService`** from a *signed* app. For a personal, ad-hoc-signed tool we'll install plists the classic way (`bootstrap`) and **explicitly test reboot survival on 26.4**; the agent will also show up in System Settings → General → Login Items for one-time approval. If 26.4 refuses to auto-run classic agents, fall back to `SMAppService` (needs real code-signing — see §8).

---

## 3. How Sentinel works, end to end

Sentinel = **Electron GUI** + a **Node "supervisor core"** (main process) that shells out to `git`, `python`/`uv`, and `launchctl`. No long-running daemon of its own — launchd is the daemon.

**Lifecycle of importing & running a bot:**

1. **Import** — two sources:
   - **Local folder** — pick a folder; Sentinel **copies it into `~/Documents/Sentinel/bots/<name>/`** (keeps files inside the Sentinel folder, per the goal).
   - **GitHub** — paste a repo URL; Sentinel `git clone`s it into `~/Documents/Sentinel/bots/<name>/`. Private repos via a Personal Access Token (or `gh` if present). (§ "GitHub import" below.)
2. **Detect** — scan the folder to figure out how to set it up & run it (lockfiles → tool, entry-point conventions). Writes a **`sentinel.json` manifest** describing the resolved launch (see §5). User can edit any field if detection is wrong.
3. **Environment** — create the venv and install deps with the detected tool (`uv sync` / `python -m venv` + pip / `poetry install`). Resolve the concrete interpreter path (`.venv/bin/python`) to launch with.
4. **Secrets / `.env`** — parse the repo's `.env.example` into a form of required keys; user fills them in; Sentinel writes a real `.env` (chmod 600). (§ "Keys & envs" below.)
5. **Telegram login (interactive)** — Telethon needs a one-time phone-number + login-code auth that creates the `.session` file. Sentinel runs this in an **embedded terminal (node-pty)** so the prompts work. (§ "Interactive login".)
6. **Register with launchd** — generate `~/Library/LaunchAgents/com.sentinel.<botid>.plist` (venv python + entry args, `WorkingDirectory`, `KeepAlive`, `RunAtLoad`, log paths) and `bootstrap` it. Bot is now live and self-healing.
7. **Supervise & observe** — GUI shows status/PID/restart-count (`launchctl print`/`list`), tails the log files live, and offers start / stop / restart / enable-autostart / disable per bot.

**Control mapping (Node → launchctl), macOS 11+ verbs:**
- Start / install: `launchctl bootstrap gui/$(id -u) <plist>`
- Stop / uninstall: `launchctl bootout gui/$(id -u)/com.sentinel.<botid>`
- Restart: `launchctl kickstart -k gui/$(id -u)/com.sentinel.<botid>`
- Status + PID: `launchctl print gui/$(id -u)/com.sentinel.<botid>`
- Autostart on boot = `RunAtLoad:true` in the plist + (machine-level) auto-login enabled.

---

## 4. Folder layout & data model

Everything under `~/Documents/Sentinel/` so the bot files live "inside this folder":

```
~/Documents/Sentinel/
  bots/
    watcherdogbot/            # imported copy (git clone or folder copy)
      .venv/                  # created by Sentinel
      .env                    # written by Sentinel (chmod 600)
      *.session               # Telethon (chmod 600)
      sentinel.json           # per-bot manifest (how to run it)
      ...the bot's own files...
    telegram-mcp/
      ...
  logs/
    watcherdogbot.out.log     # launchd StandardOutPath (rotated)
    watcherdogbot.err.log
  registry.json               # list of all managed bots (no secrets)
  (the Electron .app lives in /Applications or wherever built)
```

**Per-bot manifest — `bots/<name>/sentinel.json`** (the single source of truth the supervisor reads; non-invasive — never rewrites the bot's own code):
```jsonc
{
  "id": "wd-7f3a",
  "name": "WatcherDogBot",
  "source": { "type": "git", "url": "https://github.com/...", "branch": "main" },
  "packageManager": "venv",            // venv | uv | poetry
  "python": ".venv/bin/python",        // resolved absolute at launch time
  "entry": ["run_watcher.py", "--verbose"],
  "envFile": ".env",
  "envKeys": ["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "IBO_CHAT_ID", "..."],
  "restartPolicy": "always",           // maps to KeepAlive
  "maxRestarts": 10,                   // app-level crash-loop cutoff
  "autostart": true                    // RunAtLoad
}
```

**Secrets are NOT in any JSON.** They live in the chmod-600 `.env` (v1), with an optional upgrade to Keychain-backed injection later (§ "Keys & envs").

`registry.json` is just `[{id, name, path, label}]` for the GUI to enumerate — no secrets.

---

## 5. Answers to your specific questions

### "Can it import from GitHub?"
**Yes.** Shell out to the installed `git` CLI (Apple git 2.39) via Node `child_process` — simplest and handles all auth/redirect/LFS cases. `git clone <url> ~/Documents/Sentinel/bots/<name>`. Private repos: embed a **Personal Access Token** (`https://<token>@github.com/...`, not persisted in the remote) or use `gh repo clone` if the GitHub CLI is logged in. Detect default branch via `git symbolic-ref refs/remotes/origin/HEAD`; later updates via `git pull --ff-only`. (Considered isomorphic-git/simple-git; the raw CLI wins for a personal tool.)

### "Can it automatically ask for keys and create envs?"
**Yes.** On import, parse the repo's **`.env.example`** with `dotenv.parse()` → that gives the list of required keys (and placeholder hints). Sentinel shows a form, you fill it, Sentinel writes a real **`.env`** (chmod 600) and records the key *names* (not values) in the manifest. For the two known bots this means asking for `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, bot token, chat ids, etc. — exactly the fields their `.env.example` files already list.

### "Can it make a prompt for the project-builder AI to convert the project to this app's language?"
**Mostly unnecessary — and there's a better pattern.** Auto-detection (lockfile → tool, `Procfile`/`[project.scripts]`/`__main__.py`/`main.py`/`run.py`/`bot.py` → entry point) resolves almost every standard Python Telegram bot without touching the source. Instead of *converting your project into Sentinel's shape* (which would fight every `git pull`), Sentinel writes a **`sentinel.json` manifest** beside the bot — non-invasive, editable, the one thing the supervisor reads. **The LLM-prompt idea survives only as a fallback:** for the rare repo where detection fails, Sentinel generates a copy-paste prompt that asks an assistant to *produce a `sentinel.json`* (run command, env keys, package manager) — i.e. it generates **metadata**, not a rewrite of your bot. No language conversion, ever (the bots stay Python; Sentinel just runs them).

### "How can it run when the Mac turns off and on?"
Per §2: each bot gets a **LaunchAgent** with `RunAtLoad:true` + `KeepAlive`, installed in `~/Library/LaunchAgents`. With **auto-login enabled** (one System-Settings toggle; FileVault is already off), every reboot logs you in → launchd starts every bot automatically → no app, no human needed. Crashes are restarted by `KeepAlive` (10s throttle). Sentinel itself can also auto-launch at login (for the GUI), but the **bots don't depend on the app being open**.

---

## 6. Feature roadmap (re-scoped to the goal)

### v1 — one bot running 24/7, end to end
- [ ] Import a bot: **local folder copy** *and* **GitHub clone** into `~/Documents/Sentinel/bots/`.
- [ ] Auto-detect package manager + entry point → write `sentinel.json` (editable).
- [ ] Create venv + install deps (`venv`/`uv`/`poetry`); resolve `.venv/bin/python`.
- [ ] `.env` editor: form built from `.env.example`, written chmod 600.
- [ ] Interactive Telegram login (node-pty terminal) → `.session`.
- [ ] Generate + `bootstrap` a LaunchAgent; start/stop/restart from the GUI.
- [ ] Auto-restart on crash (launchd `KeepAlive`) + crash-loop detection in the GUI.
- [ ] Live status list (running/stopped/crashed, PID, restart count) + live log tail.
- [ ] Persist across app restarts (registry.json + manifests); bots persist via launchd.
- [ ] **Acceptance test:** import WatcherDogBot, reboot the Mac, confirm it comes back alive with no human action.

### v2 — polish
- [ ] One-toggle "enable 24/7" that sets `RunAtLoad` + walks you through enabling auto-login.
- [ ] Menu-bar icon: quick status + start/stop.
- [ ] Native crash / crash-loop notifications.
- [ ] CPU / memory per bot.
- [ ] Secrets upgrade: Keychain (`safeStorage`) → inject into the bot's subprocess env instead of a persistent `.env`.
- [ ] `git pull --ff-only` "update bot" button + re-install deps.

### v3 — "and more"
- [ ] Scheduling (cron-style) for non-always bots.
- [ ] Grouping / tags / search.
- [ ] `SMAppService` registration path (if macOS 26 requires it for reliable boot).
- [ ] Optional read-only remote status view from the phone.

---

## 7. Tech stack & concrete dependencies (from research)

- **Shell:** Electron (latest) + React (or Svelte) renderer; TypeScript.
- **Supervisor core:** Node main process shelling out to `git`, `python`/`uv`/`poetry`, `launchctl`. **No pm2.**
- **Interactive Telegram login:** **`@homebridge/node-pty-prebuilt-multiarch`** (prebuilt PTY — avoids native `node-gyp`/electron-rebuild pain). PTY is required: with plain pipes, CPython block-buffers and the `input()` prompt never reaches the UI.
- **Env parsing:** `dotenv` (`.parse()` for the `.env.example` → form).
- **Secrets (v2):** Electron **`safeStorage`** (built-in; its key lives in the Keychain). `keytar` is dead (archived 2022) — do **not** use it; if a named-entry API is ever needed, `@napi-rs/keyring`.
- **Auto-launch the GUI:** Electron's built-in **`app.setLoginItemSettings({openAtLogin:true})`** (wraps `SMAppService` on macOS 13+). Not the unmaintained `auto-launch` npm package.
- **Packaging:** electron-builder (or forge) with **ad-hoc signing** (`identity: "-"`). **No Apple Developer account, no notarization needed** to run my own local build — Apple Silicon just needs the free ad-hoc signature. (Real signing only becomes worth it if `SMAppService` auto-launch proves flaky on 26.4.)

---

## 8. Risks / open items to validate during the build

1. **macOS 26.4 + classic LaunchAgents.** Verify a `bootstrap`-installed agent actually auto-runs after reboot; if Background Task Management blocks it, switch to `SMAppService` (needs real code-signing). **Test early — it's the whole point of the app.**
2. **Auto-login.** Requires the user to flip the System Settings toggle (can't be fully scripted safely). Sentinel guides it; without it, bots only run after a manual login.
3. **uv-managed Python.** telegram-mcp uses a uv-downloaded CPython 3.13; the LaunchAgent must point at the resolved `.venv/bin/python`, and `uv` must be on PATH (or invoked by absolute path) when Sentinel sets it up.
4. **node-pty native module** must be built/prebuilt for Electron's ABI — using the prebuilt-multiarch fork avoids this.
5. **`.session` / `.env` safety.** chmod 600 both; FileVault is off, so secrets are plaintext at rest — note this; Keychain upgrade in v2.
6. **Migrating existing bots.** WatcherDogBot/telegram-mcp currently live outside Sentinel and have their own (uninstalled) plists. Importing = copy into `bots/`, write a Sentinel-owned plist, and make sure we don't double-run with any hand-installed agent.

---

## 9. First build-session steps

1. ~~Confirm §1 (drop pm2 → launchd) and §2 (LaunchAgent + auto-login).~~ ✅ both confirmed 2026-06-16.
2. Scaffold Electron + TS + React in `~/Documents/Sentinel/` (app code alongside `bots/`, `logs/`).
3. Build the supervisor core first (plist generator + `launchctl` wrapper + detection + venv setup) as plain Node modules with unit tests — UI second.
4. Vertical slice: import **WatcherDogBot** → detect → venv → `.env` form → login → LaunchAgent → see it running + tail logs.
5. **Reboot the Mac** and confirm WatcherDogBot self-resurrects (the acceptance test).
6. Then telegram-mcp (exercises the uv path), then polish (menu bar, notifications, status).

---

*Researched with citations available in the build conversation; supersedes pm2 guidance in `SENTINEL.md`.*
