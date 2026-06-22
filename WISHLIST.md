# Sentinel — Wishlist

Future features, each with a concrete plan grounded in the v1 codebase. Format:

> **What** · **Why** · **How** (which files change) · **Effort** (S/M/L) · **Risk**

## ✅ Implemented (2026-06-16) — the original wishlist is largely built

- **Real GitHub update** (#1a–1d): update-available check (`git.checkForUpdates`), pull
  → reinstall-if-deps-changed → restart (`supervisor.updateBot`), scheduled auto-update
  via the background agent + per-bot toggle, and crash-loop rollback to `lastGoodSha`.
- **Crash-loop give-up** (#2): monitor boots out a bot past `maxRestarts` (`monitor.ts`),
  status surfaces as `crash-looping`.
- **Telegram crash alerts** (#3): `notify.ts` DMs the owner; token encrypted via
  `safeStorage`.
- **Menu-bar tray** (#4): live `running/total`, per-bot start/stop/restart.
- **Keychain secrets** (#5): notifier token via `safeStorage` (verified available).
- **Scheduling** (#6): `StartInterval` / `StartCalendarInterval` in `plist.ts` + Settings.
- **CPU/memory** (#7): `ps`-based per-bot stats in the runtime.
- **Test run** (#8): foreground pty run (`startTestRun`, shares the login pty path).
- **Framework detection** (#9): telethon/aiogram/pyrogram/bot-api in `detect.ts`.
- **Phone control** (#10): `telegramBot.ts` — inbound `getUpdates` bot driving the
  supervisor (status/list/start/stop/restart/logs/update, inline keyboards, owner-only).
- **Always-on background agent**: headless `--agent` Electron process under a launchd
  agent so monitoring/alerts/auto-update run with the GUI closed (`agentctl.ts`).
- Plus tags + sidebar search, bulk start/stop-all, a Preferences modal.

## ✋ Consciously NOT built (documented, not forgotten)

- **Webhook-triggered update** (#1e): needs inbound networking/tunnel — polling suffices.
- **LaunchDaemon (root) mode**: overkill/fragile vs LaunchAgent + auto-login.
- **SMAppService registration**: only if a future macOS blocks classic agents (26.4 is fine).
- **Sentinel self-update**: needs signing/hosting; `git pull + npm run package` is enough.
- **Adopt existing hand-written plists**, **env profiles**: low value for now.

The plans below remain as design notes / future polish.

---

Tiers: **▶ Next up** · **◷ Later** · **◇ Maybe**.

---

## ▶ 1. Real "update from GitHub" (the flagship)

Today "Pull latest" only fast-forwards the working tree. A bot running old code in
memory keeps running old code, and if `requirements.txt` changed the venv is now
stale. Turn this into a proper update pipeline.

### 1a. Update-available indicator  · S · low risk
- **What:** show a badge when a git bot is behind its remote, without changing anything.
- **How:** add `git.ts → checkForUpdates(dir, branch)`:
  ```
  git -C dir fetch origin --quiet
  behind = git -C dir rev-list --count HEAD..origin/<branch>
  ```
  Return `{ behind, latestSha }`. Surface as `runtime.updatesBehind` (new field on
  `BotRuntime`), computed in `supervisor.runtimeOf`. Render a dot/badge in `App.tsx`
  sidebar and `BotDetail` overview. Cache the fetch (don't fetch on every `listBots`;
  fetch on a timer or on demand).

### 1b. Pull → reinstall-if-needed → restart  · M · medium risk
- **What:** make "Update" actually ship new code to the running bot.
- **How:** extend `supervisor.updateBot`:
  1. `prevSha = git rev-parse HEAD` (remember for rollback, 1d).
  2. `git pull --ff-only` (existing).
  3. Detect dependency churn: `git diff --name-only <prevSha> HEAD` — if it touches
     `requirements.txt | pyproject.toml | uv.lock | poetry.lock | Pipfile*`, call
     `setupBotEnv(id)` to rebuild the venv.
  4. If the agent is installed, `launchctl.restart(id)` (`kickstart -k`) so the new
     code/venv takes effect. Stream everything to the existing `setup` channel.
- **Risk:** a pull that breaks deps can leave the bot down → pair with 1d (rollback).

### 1c. Scheduled auto-update (works with the app closed)  · L · medium risk
- **What:** keep bots current automatically, on the 24/7 ethos (no app needed).
- **Why a separate agent:** bots run via launchd independent of the GUI; an in-app
  `setInterval` only updates while Sentinel is open. The robust path is its own agent.
- **How:**
  - Add plist support for `StartInterval` (and/or `StartCalendarInterval`) in
    `plist.ts` — currently only `KeepAlive`/`RunAtLoad` exist.
  - Ship a headless updater entry (e.g. `out/updater/index.js`, a second
    electron-vite build target or a plain Node script) that reads `registry.json`,
    and for each git bot with `autoUpdate: true` runs the 1b pipeline.
  - Install one agent `com.sentinel.updater.plist` with `StartInterval` = e.g. 21600
    (6h), reusing `launchctl.installAgent`.
  - New manifest fields: `autoUpdate: boolean`, `updateIntervalHours: number`,
    `updateChannel?: string` (branch). UI toggle in Settings.
  - **Alternative (simpler, app-only):** a `setInterval` in `main/index.ts` calling
    1b — fine as a first cut, documented as "only while Sentinel runs."

### 1d. Safe rollback on a bad update  · M · medium risk
- **What:** if a bot crash-loops right after an update, revert it.
- **How:** after 1b restarts the bot, watch `launchctl.status().runs` climb fast
  within ~2 min (ties into the crash-loop monitor, item 2). On crash-loop:
  `git reset --hard <prevSha>`, re-run `setupBotEnv`, `kickstart -k`, and notify
  (item 3). Store `prevSha` on the manifest as `lastGoodSha`.

### 1e. Webhook-triggered update  · L · high risk
- **What:** pull the instant you push to GitHub.
- **Reality check:** needs an inbound endpoint (local server + a tunnel like
  cloudflared, or GitHub Actions self-hosted runner). Heavy for a personal Mac mini.
  **Recommendation:** skip — 1c polling every few hours is enough. Documented here so
  it's a conscious "no," not an oversight.

---

## ▶ 2. Crash-loop detection & give-up  · M · medium risk
- **What:** launchd restarts a crashing bot forever (every `ThrottleInterval`, 10s).
  Detect a bot that's flapping, stop hammering, and flag it.
- **Why:** a misconfigured bot silently burns CPU and floods logs forever.
- **How:** `maxRestarts` already exists on the manifest but is unused. Add a monitor
  (in `main/index.ts` while app is open, or in the updater agent for always-on) that
  reads `launchctl.status().runs` deltas over a window; if > `maxRestarts` within N
  minutes, `launchctl.bootout(id)`, set status `crashed`, and notify (item 3). Surface
  a "restart anyway" button. **Note:** truly-always-on detection needs the agent, not
  the GUI — be honest in the UI about which mode is active.

## ▶ 3. Notify me when a bot dies — *via Telegram*  · M · low/medium risk
- **What:** push a message when a bot crashes / crash-loops / gets auto-updated.
- **Why it's the best fit:** these *are* Telegram tools — DM yourself, works even when
  the Mac's screen is off and the app is closed (if sent by the agent). Beats native
  notifications, which only fire while the app is open.
- **How:** store a notifier bot token + your chat id (Keychain or a small config).
  On an event, POST to `https://api.telegram.org/bot<token>/sendMessage`
  (one `fetch`, zero deps). Also offer native `Notification` (Electron) when the app
  is open. New file `core/notify.ts`; called from the monitor (item 2) and updater.
- **Risk:** storing yet another token; keep it in Keychain (item 5).

## ▶ 4. Menu-bar tray  · S/M · low risk
- **What:** a menu-bar icon: per-bot status dots, quick start/stop/restart, "open Sentinel."
- **How:** Electron `Tray` + `Menu` in `main/index.ts`, rebuilt from `listBots()` on
  the existing `evtBotsChanged` event. Color the template icon by worst bot status.

---

## ◷ 5. Keychain-backed secrets  · M · medium risk · *be honest about the payoff*
- **What:** stop keeping secrets in a plaintext `.env`.
- **How:** Electron `safeStorage.encryptString` (key lives in the macOS Keychain);
  store ciphertext in app data; on start, materialize the `.env` (still chmod 600) or
  inject via the subprocess env. `keytar` is dead — don't use it.
- **Honest caveat:** a *persistent* decrypted `.env` is barely better than today.
  The real win is **ephemeral** injection (write `.env`, let the bot load it, delete)
  — but Telethon/python-dotenv read lazily, so timing is tricky. For a single-user Mac,
  `.env` chmod 600 + FileVault is already most of the value. Prioritize accordingly.
- **Related:** warn if a bot dir (with `.env`/`.session`) sits in iCloud/Dropbox; the
  Telethon `.session` is login-equivalent — chmod 600 it and never sync it.

## ◷ 6. Run on a schedule (not always-on)  · M · low risk
- **What:** some bots should run at times, not forever (reports, cron-like jobs).
- **How:** add `StartCalendarInterval` to `plist.ts`; new manifest `schedule` field;
  set `restartPolicy: never` + `RunAtLoad: false` for scheduled bots. UI: a simple
  cron/time picker in Settings.

## ◷ 7. CPU / memory per bot  · S · low risk
- **What:** show resource use in the overview and tray.
- **How:** `ps -o %cpu=,rss= -p <pid>` on a timer for each running bot's
  `runtime.pid`; add `cpu`/`memMB` to `BotRuntime`. (Avoid extra deps.)

## ◷ 8. "Test run" before going 24/7  · S · low risk
- **What:** run the bot once in the foreground (pty), confirm it boots and connects,
  *then* offer "Start 24/7." Catches bad entry/missing deps before installing an agent.
- **How:** reuse `LoginSession` (already a pty runner) with a "test" label; on clean
  run, enable the Start button. Mostly UI wiring.

## ◷ 9. Smarter bot-type detection  · M · low risk
- **What:** recognize Telethon vs Bot API vs aiogram and tailor onboarding (e.g. only
  Telethon/user-session bots need the phone-code `.session` login).
- **How:** grep deps/imports in `detect.ts` (`telethon`, `aiogram`, `python-telegram-bot`);
  add `framework` to the manifest; the Setup tab shows/hides the login step accordingly.

## ◷ 10. Control Sentinel from your phone (Telegram)  · L · medium risk
- **What:** DM a Sentinel control-bot `/status`, `/restart watcherdog`, `/logs` and get
  replies — the "remote view from phone" from the original plan, done natively.
- **How:** Sentinel runs its own small managed bot (long-poll the Bot API) that maps
  commands to `supervisor` calls; whitelist your user id. It's literally a bot Sentinel
  supervises like any other — dogfood. **Risk:** remote control surface → strict allow-list.

---

## ◇ Maybe (lower priority / higher cost)

- **LaunchDaemon mode** (true headless, no login) · L · high risk — write to
  `/Library/LaunchDaemons` via an admin prompt (`osascript ... with administrator
  privileges` or `SMAppService`). Runs as root, no user Keychain, messier perms. Only
  if auto-login proves unacceptable. (v1 chose LaunchAgent + auto-login deliberately.)
- **SMAppService registration** · M — fallback if a future macOS blocks classic
  `bootstrap`-installed agents (verified fine on 26.4, but watch this). Needs real
  code-signing.
- **Sentinel self-update** · M — the app updating itself. electron-updater needs
  signing + hosting; for a local build, a "git pull + `npm run package`" helper script
  is the pragmatic version.
- **Grouping / tags / search / bulk start-stop-all** · S — once there are many bots.
- **Import existing hand-written plists** · S — detect `~/Library/LaunchAgents/*.plist`
  (e.g. the old `com.watcherdog.*`) and offer to adopt them as managed bots.
- **Onboarding wizard** · S — guided first-run: import → setup → login → start.
- **Log search / download / rotation policy UI** · S — logs already stream; add find +
  size caps surfaced in the UI.
- **Env profiles** · S — dev/prod `.env` sets per bot.

---

## Suggested order

1. **#1a + #1b** — update available + pull/reinstall/restart (finishes the headline,
   small surface, immediately useful).
2. **#3** — Telegram crash notifications (high value, on-theme, low cost).
3. **#2** — crash-loop give-up (prevents silent CPU/log burn).
4. **#1c/#1d** — scheduled auto-update + rollback (the always-on version).
5. **#4** — menu-bar tray (daily-driver polish).

Everything in tier ▶ is achievable without new heavy dependencies — mostly new
functions in `git.ts`/`supervisor.ts`, a couple of `plist.ts` keys, and UI wiring.
