import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Bot, Schedule } from '@shared/types'
import { Console } from './Console'
import { EnvForm } from './EnvForm'
import { Switch } from './Switch'

interface Props {
  bot: Bot
  onChanged: () => void
}

type Tab = 'overview' | 'setup' | 'logs' | 'settings'

const STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  crashed: 'Crashed',
  'crash-looping': 'Crash-looping',
  scheduled: 'Scheduled',
  starting: 'Starting',
  'not-installed': 'Not started',
  unknown: 'Unknown'
}

export function BotDetail({ bot, onChanged }: Props): React.ReactElement {
  const [tab, setTab] = useState<Tab>('overview')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  // Reset tab-local error when switching bots.
  useEffect(() => setError(''), [bot.manifest.id])

  async function act(label: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(label)
    setError('')
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setBusy('')
    }
  }

  const r = bot.runtime
  const id = bot.manifest.id

  return (
    <div>
      <div className="detail-head">
        <span className={`dot ${r.status}`} />
        <h2>{bot.manifest.name}</h2>
        <span className={`badge ${r.status === 'running' ? 'ok' : r.status === 'crashed' ? 'err' : ''}`}>
          {STATUS_LABEL[r.status] ?? r.status}
        </span>
      </div>
      <div className="detail-sub">{bot.dir}</div>

      <div className="controls">
        <button
          className="primary"
          disabled={!!busy || !r.envReady}
          onClick={() => void act('start', () => api.start(id))}
          title={r.envReady ? 'Install the launchd agent and start' : 'Set up the environment first'}
        >
          {busy === 'start' ? 'Starting…' : r.installed ? 'Start / Reload' : 'Start 24/7'}
        </button>
        <button disabled={!!busy || !r.installed} onClick={() => void act('stop', () => api.stop(id))}>
          Stop
        </button>
        <button disabled={!!busy} onClick={() => void act('restart', () => api.restart(id))}>
          Restart
        </button>
        <button className="ghost small" onClick={() => void api.revealBotDir(id)}>
          Reveal in Finder
        </button>
        {bot.manifest.source.type === 'git' && (
          <button
            className="ghost small"
            disabled={!!busy}
            onClick={() => {
              setTab('setup')
              void act('pull', () => api.updateBot(id))
            }}
          >
            Pull latest
          </button>
        )}
        {bot.manifest.source.type === 'git' && (
          <button
            className="ghost small"
            disabled={!!busy}
            title="Snapshot this bot's current files (incl. AI edits) to a sentinel-live branch and push it"
            onClick={() => {
              setTab('setup')
              void act('push', async () => {
                const r = await api.pushLive(id)
                if (r.url) window.open(r.url, '_blank')
              })
            }}
          >
            {busy === 'push' ? 'Pushing…' : 'Push → sentinel-live'}
          </button>
        )}
      </div>

      {error && (
        <div className="err-text" role="alert">
          <span aria-hidden="true">⚠️</span>
          <span>{error}</span>
        </div>
      )}

      <div className="tabs" role="tablist">
        {(['overview', 'setup', 'logs', 'settings'] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'setup' ? 'Setup & Login' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="tab-panel" key={tab}>
        {tab === 'overview' && (
          <Overview bot={bot} onAutostart={(on) => void act('auto', () => api.setAutostart(id, on))} />
        )}
        {tab === 'setup' && <SetupTab bot={bot} busy={busy} act={act} onChanged={onChanged} />}
        {tab === 'logs' && <LogsTab botId={id} />}
        {tab === 'settings' && <SettingsTab bot={bot} onChanged={onChanged} />}
      </div>
    </div>
  )
}

function Overview({ bot, onAutostart }: { bot: Bot; onAutostart: (on: boolean) => void }): React.ReactElement {
  const r = bot.runtime
  const m = bot.manifest
  const isNode = m.runtime === 'node'
  const ready = r.envReady && r.envFilePresent
  return (
    <>
      <div className="card">
        <h3>24/7 readiness</h3>
        <div className="kv">
          <span className="k">Environment</span>
          <span className="v">
            <span className={`badge ${r.envReady ? 'ok' : 'warn'}`}>
              {r.envReady ? (isNode ? 'deps ready' : 'venv ready') : 'not set up'}
            </span>
          </span>
          <span className="k">Config (.env)</span>
          <span className="v">
            <span className={`badge ${r.envFilePresent ? 'ok' : 'warn'}`}>
              {r.envFilePresent ? 'present' : 'missing'}
            </span>
          </span>
          <span className="k">launchd agent</span>
          <span className="v">
            <span className={`badge ${r.installed ? 'ok' : ''}`}>{r.installed ? 'installed' : 'not installed'}</span>
          </span>
          <span className="k">Start at login</span>
          <span className="v">
            <Switch
              checked={m.autostart}
              onChange={onAutostart}
              label={m.autostart ? 'Yes (RunAtLoad)' : 'No'}
            />
          </span>
        </div>
        {!ready && <p className="note">Go to “Setup &amp; Login” to create the environment and fill in secrets.</p>}
      </div>

      <div className="card">
        <h3>Runtime</h3>
        <div className="kv">
          <span className="k">Status</span>
          <span className="v">{STATUS_LABEL[r.status] ?? r.status}</span>
          <span className="k">PID</span>
          <span className="v">{r.pid ?? '—'}</span>
          <span className="k">Restarts (launchd)</span>
          <span className="v">{r.restarts}</span>
          <span className="k">Last exit code</span>
          <span className="v">{r.lastExitCode ?? '—'}</span>
          <span className="k">CPU / Memory</span>
          <span className="v">
            {r.cpu != null ? `${r.cpu.toFixed(1)}%` : '—'} /{' '}
            {r.memMB != null ? `${r.memMB} MB${r.memPct != null ? ` (${r.memPct}%)` : ''}` : '—'}
          </span>
          <span className="k">Uptime</span>
          <span className="v">{r.uptime ?? '—'}</span>
          <span className="k">Restart policy</span>
          <span className="v">{m.restartPolicy}</span>
        </div>
      </div>

      {m.source.type === 'git' && <UpdatesCard bot={bot} />}

      <div className="card">
        <h3>Launch</h3>
        <div className="kv">
          <span className="k">Runtime</span>
          <span className="v">{isNode ? 'Node.js' : 'Python'}</span>
          <span className="k">Package manager</span>
          <span className="v">{m.packageManager}</span>
          {!isNode && (
            <>
              <span className="k">Interpreter</span>
              <span className="v">{m.python}</span>
            </>
          )}
          <span className="k">Entry</span>
          <span className="v">{launchSummary(m)}</span>
          {m.miniApp?.enabled && (
            <>
              <span className="k">Mini App</span>
              <span className="v">
                <span className="badge ok">on</span> {m.miniApp.webFramework} · :{m.miniApp.port} ·{' '}
                {m.miniApp.tunnel === 'cloudflared' ? 'cloudflared tunnel' : 'public URL'}
              </span>
            </>
          )}
          {m.framework && m.framework !== 'unknown' && (
            <>
              <span className="k">Framework</span>
              <span className="v">{m.framework}</span>
            </>
          )}
          <span className="k">Source</span>
          <span className="v">{m.source.type === 'git' ? m.source.origin : 'local folder'}</span>
        </div>
      </div>
    </>
  )
}

/** Human-readable summary of how a bot launches (handles Node entry markers). */
function launchSummary(m: Bot['manifest']): string {
  const first = m.entry[0]
  if (!first) return '(none set)'
  if (first === '__miniapp__') return `${m.packageManager} run ${m.miniApp?.script ?? '?'} (Mini App)`
  if (first.startsWith('__npm__:')) return `${m.packageManager} run ${first.slice('__npm__:'.length)}`
  if (first === '__nodefile__') return `node ${m.entry.slice(1).join(' ')}`
  return m.entry.join(' ')
}

/** Git update check + one-click update for the selected bot. */
function UpdatesCard({ bot }: { bot: Bot }): React.ReactElement {
  const id = bot.manifest.id
  const [behind, setBehind] = useState<number | null>(null)
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [msg, setMsg] = useState('')
  const [runId, setRunId] = useState(0)

  async function check(): Promise<void> {
    setChecking(true)
    setMsg('')
    try {
      const r = await api.checkUpdates(id)
      if (!r.isGit) setMsg('Not a git repo.')
      else if (r.error) setMsg(`Could not check: ${r.error}`)
      else {
        setBehind(r.behind)
        setMsg(r.behind === 0 ? 'Up to date.' : `${r.behind} commit(s) behind ${r.branch ?? ''}.`)
      }
    } finally {
      setChecking(false)
    }
  }

  async function update(): Promise<void> {
    setUpdating(true)
    setRunId((n) => n + 1)
    try {
      await api.updateBot(id)
      setBehind(0)
      setMsg('Updated.')
    } catch (e) {
      setMsg(String((e as Error).message ?? e))
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="card">
      <h3>GitHub updates</h3>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <button className="small" onClick={() => void check()} disabled={checking || updating}>
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
        <button
          className="small primary"
          onClick={() => void update()}
          disabled={updating || behind === 0}
          title="Pull, reinstall deps if changed, and restart"
        >
          {updating ? 'Updating…' : behind && behind > 0 ? `Update (${behind})` : 'Pull & restart'}
        </button>
        {behind != null && behind > 0 && <span className="badge warn">{behind} behind</span>}
        {behind === 0 && <span className="badge ok">up to date</span>}
      </div>
      {msg && <p className="note">{msg}</p>}
      {updating && <Console botId={id} channel="setup" short resetKey={runId} />}
    </div>
  )
}

type ActFn = (label: string, fn: () => Promise<unknown>) => Promise<void>

function SetupTab({
  bot,
  busy,
  act,
  onChanged
}: {
  bot: Bot
  busy: string
  act: ActFn
  onChanged: () => void
}): React.ReactElement {
  const id = bot.manifest.id
  const isNode = bot.manifest.runtime === 'node'
  const [runId, setRunId] = useState(0)
  return (
    <>
      <div className="card">
        <h3>1 · Environment</h3>
        <p className="note">
          {isNode ? (
            <>
              Installs dependencies into <code>node_modules</code> using <b>{bot.manifest.packageManager}</b>. Re-run
              anytime (e.g. after editing <code>package.json</code>).
            </>
          ) : (
            <>
              Creates <code>.venv</code> and installs dependencies using <b>{bot.manifest.packageManager}</b>. Re-run
              anytime (e.g. after editing requirements).
            </>
          )}
        </p>
        <div className="row" style={{ margin: '10px 0' }}>
          <button
            className="primary"
            disabled={!!busy}
            onClick={() => {
              setRunId((n) => n + 1)
              void act('setup', () => api.setupEnv(id))
            }}
          >
            {busy === 'setup' ? 'Setting up…' : bot.runtime.envReady ? 'Re-run setup' : 'Set up environment'}
          </button>
          {bot.runtime.envReady && <span className="badge ok">{isNode ? 'deps ready' : 'venv ready'}</span>}
        </div>
        <Console botId={id} channel="setup" short resetKey={runId} />
      </div>

      <div className="card">
        <h3>2 · Secrets (.env)</h3>
        {bot.manifest.miniApp?.enabled && (
          <p className="note">
            Add <code>TELEGRAM_BOT_TOKEN</code> here so Sentinel can register the Mini App as your bot’s menu button on
            start.
          </p>
        )}
        <EnvForm botId={id} onSaved={onChanged} />
      </div>

      {isNode ? (
        bot.manifest.miniApp?.enabled && (
          <div className="card">
            <h3>3 · How it’s served</h3>
            <p className="note">
              On Start, Sentinel runs <code>{bot.manifest.packageManager} run {bot.manifest.miniApp.script}</code> on
              port <b>{bot.manifest.miniApp.port}</b>
              {bot.manifest.miniApp.tunnel === 'cloudflared' ? (
                <>
                  , opens a <b>cloudflared</b> HTTPS tunnel, and registers the tunnel URL as your bot’s menu button.
                </>
              ) : (
                <>
                  {' '}
                  and registers <code>{bot.manifest.miniApp.publicUrl || '(set a public URL in Settings)'}</code> as
                  your bot’s menu button.
                </>
              )}{' '}
              Edit any of this in <b>Settings</b>.
            </p>
          </div>
        )
      ) : (
        <div className="card">
          <h3>3 · First-time Telegram login</h3>
          <LoginSection bot={bot} />
        </div>
      )}
    </>
  )
}

function LoginSection({ bot }: { bot: Bot }): React.ReactElement {
  const id = bot.manifest.id
  const [mode, setMode] = useState<'idle' | 'pty' | 'terminal'>('idle')
  const [terminalCmd, setTerminalCmd] = useState('')
  const [reason, setReason] = useState('')
  const [exited, setExited] = useState<number | null | undefined>(undefined)
  const [input, setInput] = useState('')
  const [runId, setRunId] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return api.onLoginExit((e) => {
      if (e.botId === id) setExited(e.code)
    })
  }, [id])

  // Stop any session when leaving / switching bots.
  useEffect(() => {
    return () => api.stopLogin(id)
  }, [id])

  async function startLogin(): Promise<void> {
    setExited(undefined)
    setRunId((n) => n + 1)
    const res = await api.startLogin(id)
    if (res.mode === 'pty') {
      setMode('pty')
      setTimeout(() => inputRef.current?.focus(), 50)
    } else {
      setMode('terminal')
      setTerminalCmd(res.command)
      setReason(res.reason)
    }
  }

  function send(): void {
    api.loginInput(id, input + '\n')
    setInput('')
  }

  return (
    <div>
      <p className="note">
        Telethon bots need a one-time login (phone number + code) to create the <code>.session</code> file. Run it
        once here, complete the prompts, then stop it and Start 24/7.
      </p>
      <div className="row" style={{ margin: '10px 0', gap: 8 }}>
        <button className="primary" onClick={() => void startLogin()} disabled={mode === 'pty'}>
          {mode === 'pty' ? 'Login running…' : 'Run first-time login'}
        </button>
        <button className="small" onClick={() => void api.openInTerminal(id)}>
          Open in Terminal instead
        </button>
        {mode === 'pty' && (
          <button
            className="small danger"
            onClick={() => {
              api.stopLogin(id)
              setMode('idle')
            }}
          >
            Stop
          </button>
        )}
      </div>

      {mode === 'pty' && (
        <>
          <Console botId={id} channel="login" resetKey={runId} />
          <div className="login-input">
            <input
              ref={inputRef}
              value={input}
              placeholder="Type a response (e.g. +1555…, then the code) and press Enter"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              spellCheck={false}
            />
            <button className="small" onClick={send}>
              Send
            </button>
          </div>
          {exited !== undefined && <p className="note">Login process exited (code {String(exited)}).</p>}
        </>
      )}

      {mode === 'terminal' && (
        <div>
          <div className="banner warn">{reason}</div>
          <p className="note">Run this in Terminal to complete the login:</p>
          <div className="console short" style={{ height: 'auto', minHeight: 0, padding: 10 }}>
            {terminalCmd}
          </div>
          <button className="small primary" style={{ marginTop: 8 }} onClick={() => void api.openInTerminal(id)}>
            Open in Terminal
          </button>
        </div>
      )}
    </div>
  )
}

function LogsTab({ botId }: { botId: string }): React.ReactElement {
  useEffect(() => {
    void api.startLogTail(botId)
    return () => api.stopLogTail(botId)
  }, [botId])
  return (
    <div className="card">
      <h3>Live logs (stdout + stderr)</h3>
      <Console botId={botId} channel="log" resetKey={botId} />
    </div>
  )
}

function SettingsTab({ bot, onChanged }: { bot: Bot; onChanged: () => void }): React.ReactElement {
  const m = bot.manifest
  const isNode = m.runtime === 'node'
  const [entry, setEntry] = useState(m.entry.join(' '))
  const [python, setPython] = useState(m.python)
  const [policy, setPolicy] = useState(m.restartPolicy)
  const [pm, setPm] = useState(m.packageManager)
  const [tags, setTags] = useState((m.tags ?? []).join(', '))
  // Mini App (Node web apps) — defaults cover plain Node bots that opt in.
  const ma = m.miniApp
  const [maEnabled, setMaEnabled] = useState(!!ma?.enabled)
  const [maScript, setMaScript] = useState(ma?.script ?? 'dev')
  const [maPort, setMaPort] = useState(ma?.port ?? 3000)
  const [maTunnel, setMaTunnel] = useState<'cloudflared' | 'none'>(ma?.tunnel ?? 'cloudflared')
  const [maPublicUrl, setMaPublicUrl] = useState(ma?.publicUrl ?? '')
  const [maSetMenu, setMaSetMenu] = useState(ma?.setMenuButton ?? true)
  const [maMenuText, setMaMenuText] = useState(ma?.menuText ?? 'Open App')
  const [notifyOnCrash, setNotifyOnCrash] = useState(m.notifyOnCrash !== false)
  const [autoUpdate, setAutoUpdate] = useState(!!m.autoUpdate)
  const [updateHours, setUpdateHours] = useState(m.updateIntervalHours ?? 6)
  const [schedMode, setSchedMode] = useState<'always' | 'interval' | 'daily'>(
    m.schedule?.kind === 'interval' ? 'interval' : m.schedule?.kind === 'calendar' ? 'daily' : 'always'
  )
  const [intervalMin, setIntervalMin] = useState(
    m.schedule?.kind === 'interval' ? Math.round((m.schedule.intervalSeconds ?? 3600) / 60) : 60
  )
  const [dailyHour, setDailyHour] = useState(m.schedule?.calendar?.hour ?? 9)
  const [dailyMinute, setDailyMinute] = useState(m.schedule?.calendar?.minute ?? 0)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const dirty = (): void => setSaved(false)
  const isGit = m.source.type === 'git'

  function buildSchedule(): Schedule | undefined {
    if (schedMode === 'interval') return { kind: 'interval', intervalSeconds: Math.max(60, intervalMin * 60) }
    if (schedMode === 'daily') return { kind: 'calendar', calendar: { hour: dailyHour, minute: dailyMinute } }
    return undefined
  }

  function buildMiniApp(): Bot['manifest']['miniApp'] {
    if (!isNode) return ma // leave Python bots untouched
    if (!maEnabled) return ma ? { ...ma, enabled: false } : undefined
    return {
      enabled: true,
      script: maScript.trim() || 'dev',
      port: maPort,
      tunnel: maTunnel,
      webFramework: ma?.webFramework ?? 'node',
      publicUrl: maTunnel === 'none' ? maPublicUrl.trim() : ma?.publicUrl,
      setMenuButton: maSetMenu,
      menuText: maMenuText.trim() || 'Open App'
    }
  }

  async function save(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await api.updateManifest(m.id, {
        entry: entry.trim().length ? entry.trim().split(/\s+/) : [],
        python: python.trim(),
        restartPolicy: policy,
        packageManager: pm,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        notifyOnCrash,
        autoUpdate,
        updateIntervalHours: updateHours,
        schedule: buildSchedule(),
        miniApp: buildMiniApp()
      })
      setSaved(true)
      onChanged()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (!confirm(`Remove "${m.name}"? This stops it and deletes its folder under bots/.`)) return
    await api.removeBot(m.id)
    onChanged()
  }

  return (
    <>
      <div className="card">
        <h3>Launch settings</h3>
        <label className="field">
          <span>Entry (interpreter args, space-separated). Use __script__:name for a console script.</span>
          <input value={entry} onChange={(e) => { setEntry(e.target.value); dirty() }} spellCheck={false} />
        </label>
        <label className="field">
          <span>Interpreter (relative to bot dir, or absolute)</span>
          <input value={python} onChange={(e) => { setPython(e.target.value); dirty() }} spellCheck={false} />
        </label>
        <label className="field">
          <span>Restart policy</span>
          <select value={policy} onChange={(e) => { setPolicy(e.target.value as typeof policy); dirty() }}>
            <option value="always">always (KeepAlive)</option>
            <option value="on-crash">on-crash (restart unless clean exit)</option>
            <option value="never">never</option>
          </select>
        </label>
        <label className="field">
          <span>Package manager</span>
          <select value={pm} onChange={(e) => { setPm(e.target.value as typeof pm); dirty() }}>
            {isNode ? (
              <>
                <option value="npm">npm</option>
                <option value="pnpm">pnpm</option>
                <option value="yarn">yarn</option>
                <option value="bun">bun</option>
              </>
            ) : (
              <>
                <option value="venv">venv (pip)</option>
                <option value="uv">uv</option>
                <option value="poetry">poetry</option>
                <option value="pipenv">pipenv</option>
                <option value="existing">existing</option>
              </>
            )}
          </select>
        </label>
        <label className="field">
          <span>Tags (comma-separated, for grouping/search)</span>
          <input value={tags} onChange={(e) => { setTags(e.target.value); dirty() }} placeholder="telegram, prod" spellCheck={false} />
        </label>
      </div>

      {isNode && (
        <div className="card">
          <h3>Telegram Mini App</h3>
          <p className="note">
            Run this Node web app as a Telegram Mini App: Sentinel serves it locally, exposes it over HTTPS, and points
            your bot’s menu button at it. Requires <code>cloudflared</code> for the tunnel
            (<code>brew install cloudflared</code>).
          </p>
          <div style={{ marginBottom: 10 }}>
            <Switch checked={maEnabled} onChange={(v) => { setMaEnabled(v); dirty() }} label="Run as a Mini App" />
          </div>
          {maEnabled && (
            <>
              <div className="row" style={{ gap: 8 }}>
                <label className="field" style={{ flex: 2 }}>
                  <span>Start script (package.json)</span>
                  <input value={maScript} onChange={(e) => { setMaScript(e.target.value); dirty() }}
                    placeholder="dev" spellCheck={false} />
                </label>
                <label className="field" style={{ flex: 1 }}>
                  <span>Port</span>
                  <input type="number" min={1} max={65535} value={maPort}
                    onChange={(e) => { setMaPort(parseInt(e.target.value, 10) || 3000); dirty() }} />
                </label>
              </div>
              <label className="field">
                <span>HTTPS exposure</span>
                <select value={maTunnel}
                  onChange={(e) => { setMaTunnel(e.target.value as 'cloudflared' | 'none'); dirty() }}>
                  <option value="cloudflared">cloudflared tunnel (auto HTTPS URL)</option>
                  <option value="none">None — I’ll provide a public URL</option>
                </select>
              </label>
              {maTunnel === 'none' && (
                <label className="field">
                  <span>Public HTTPS URL</span>
                  <input value={maPublicUrl} onChange={(e) => { setMaPublicUrl(e.target.value); dirty() }}
                    placeholder="https://myapp.example.com" spellCheck={false} />
                </label>
              )}
              <div style={{ margin: '10px 0' }}>
                <Switch checked={maSetMenu} onChange={(v) => { setMaSetMenu(v); dirty() }}
                  label="Register the bot’s menu button on start" />
              </div>
              {maSetMenu && (
                <label className="field">
                  <span>Menu button label</span>
                  <input value={maMenuText} onChange={(e) => { setMaMenuText(e.target.value); dirty() }}
                    placeholder="Open App" spellCheck={false} />
                </label>
              )}
              <p className="note">
                Menu-button registration reads <code>TELEGRAM_BOT_TOKEN</code> (or <code>BOT_TOKEN</code>) from the bot’s
                <code> .env</code> on the Setup tab.
              </p>
            </>
          )}
        </div>
      )}

      <div className="card">
        <h3>Schedule</h3>
        <label className="field">
          <span>Run mode</span>
          <select value={schedMode} onChange={(e) => { setSchedMode(e.target.value as typeof schedMode); dirty() }}>
            <option value="always">Always on (24/7, KeepAlive)</option>
            <option value="interval">Every N minutes</option>
            <option value="daily">Daily at a time</option>
          </select>
        </label>
        {schedMode === 'interval' && (
          <label className="field">
            <span>Interval (minutes)</span>
            <input type="number" min={1} value={intervalMin}
              onChange={(e) => { setIntervalMin(parseInt(e.target.value, 10) || 1); dirty() }} />
          </label>
        )}
        {schedMode === 'daily' && (
          <div className="row" style={{ gap: 8 }}>
            <label className="field" style={{ flex: 1 }}>
              <span>Hour (0–23)</span>
              <input type="number" min={0} max={23} value={dailyHour}
                onChange={(e) => { setDailyHour(parseInt(e.target.value, 10) || 0); dirty() }} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Minute (0–59)</span>
              <input type="number" min={0} max={59} value={dailyMinute}
                onChange={(e) => { setDailyMinute(parseInt(e.target.value, 10) || 0); dirty() }} />
            </label>
          </div>
        )}
        <p className="note">Scheduled bots run to completion each tick (no KeepAlive). Start/Reload to apply.</p>
      </div>

      <div className="card">
        <h3>Updates &amp; alerts</h3>
        <div style={{ marginBottom: 10 }}>
          <Switch checked={notifyOnCrash} onChange={(v) => { setNotifyOnCrash(v); dirty() }}
            label="Notify me if this bot crashes" />
        </div>
        {isGit ? (
          <>
            <div style={{ marginBottom: 10 }}>
              <Switch checked={autoUpdate} onChange={(v) => { setAutoUpdate(v); dirty() }}
                label="Auto-pull from GitHub on a schedule" />
            </div>
            {autoUpdate && (
              <label className="field">
                <span>Check every (hours)</span>
                <input type="number" min={1} value={updateHours}
                  onChange={(e) => { setUpdateHours(parseInt(e.target.value, 10) || 1); dirty() }} />
              </label>
            )}
            <p className="note">Auto-update also requires the global toggle in Preferences (and ideally the background agent).</p>
          </>
        ) : (
          <p className="note">Auto-update is only available for bots imported from GitHub.</p>
        )}
      </div>

      <div className="card">
        <div className="row">
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
          {saved && <span className="badge ok">Saved — Start/Reload to apply</span>}
          <span className="spacer" />
          <button className="danger" onClick={() => void remove()}>
            Remove bot
          </button>
        </div>
        {error && <div className="err-text">{error}</div>}
      </div>
    </>
  )
}
