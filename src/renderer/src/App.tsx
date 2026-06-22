import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import type { Bot } from '@shared/types'
import type { SystemInfo } from '@shared/ipc'
import { BotDetail } from './components/BotDetail'
import { ImportModal } from './components/ImportModal'
import { PreferencesModal } from './components/PreferencesModal'
import { Switch } from './components/Switch'

export default function App(): React.ReactElement {
  const [bots, setBots] = useState<Bot[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [showPrefs, setShowPrefs] = useState(false)
  const [query, setQuery] = useState('')
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const list = await api.listBots()
    setBots(list)
    setSelectedId((cur) => cur ?? list[0]?.manifest.id ?? null)
    setSys(await api.getSystemInfo())
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
    return api.onBotsChanged(() => void refresh())
  }, [refresh])

  const selected = bots.find((b) => b.manifest.id === selectedId) ?? null

  // Warn if any bot wants autostart but auto-login isn't set (won't survive reboot).
  const wantsReboot = bots.some((b) => b.manifest.autostart && b.runtime.installed)
  const rebootReady = !!sys?.autoLoginUser

  const running = bots.filter((b) => b.runtime.status === 'running').length
  const crashed = bots.filter((b) => b.runtime.status === 'crashed' || b.runtime.status === 'crash-looping').length

  const q = query.trim().toLowerCase()
  const visible = q
    ? bots.filter(
        (b) =>
          b.manifest.name.toLowerCase().includes(q) ||
          (b.manifest.tags ?? []).some((t) => t.toLowerCase().includes(q))
      )
    : bots

  async function startAll(): Promise<void> {
    for (const b of bots) if (b.runtime.envReady) await api.start(b.manifest.id).catch(() => {})
    void refresh()
  }
  async function stopAll(): Promise<void> {
    for (const b of bots) if (b.runtime.installed) await api.stop(b.manifest.id).catch(() => {})
    void refresh()
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <h1>Sentinel</h1>
          <p>Keep your bots alive 24/7</p>
        </div>
        {bots.length > 3 && (
          <div style={{ padding: '0 var(--s2) var(--s2)' }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or tag…"
              spellCheck={false}
              aria-label="Search bots"
            />
          </div>
        )}
        <nav className="bot-list" aria-label="Bots">
          {loading && bots.length === 0 ? (
            <>
              <div className="skeleton skeleton-row" />
              <div className="skeleton skeleton-row" />
              <div className="skeleton skeleton-row" />
            </>
          ) : (
            visible.map((b) => (
              <button
                key={b.manifest.id}
                className={`bot-row ${b.manifest.id === selectedId ? 'active' : ''}`}
                aria-current={b.manifest.id === selectedId}
                onClick={() => setSelectedId(b.manifest.id)}
              >
                <span className={`dot ${b.runtime.status}`} aria-hidden="true" />
                <span style={{ overflow: 'hidden', flex: 1, minWidth: 0 }}>
                  <span className="name">{b.manifest.name}</span>
                  <span className="sub">{labelFor(b)}</span>
                </span>
              </button>
            ))
          )}
          {!loading && bots.length === 0 && (
            <p className="note" style={{ padding: 'var(--s2)' }}>
              No bots yet.
            </p>
          )}
        </nav>
        <div className="sidebar-foot">
          <button className="primary" style={{ width: '100%' }} onClick={() => setShowImport(true)}>
            + Import bot
          </button>
          {bots.length > 1 && (
            <div className="row" style={{ gap: 'var(--s2)', marginTop: 'var(--s2)' }}>
              <button className="small" style={{ flex: 1 }} onClick={() => void startAll()}>
                Start all
              </button>
              <button className="small" style={{ flex: 1 }} onClick={() => void stopAll()}>
                Stop all
              </button>
            </div>
          )}
          <button className="ghost small" style={{ width: '100%', marginTop: 'var(--s2)' }} onClick={() => setShowPrefs(true)}>
            ⚙︎ Preferences
          </button>
          {sys && <SystemFoot sys={sys} onChanged={refresh} />}
        </div>
      </aside>

      <main className="main">
        <div className="main-inner">
          {bots.length > 0 && (
            <FleetHeader
              total={bots.length}
              running={running}
              crashed={crashed}
              wantsReboot={wantsReboot}
              rebootReady={rebootReady}
            />
          )}

          {wantsReboot && !rebootReady && (
            <div className="banner warn" role="alert">
              <span className="banner-icon" aria-hidden="true">
                ⚠️
              </span>
              <div className="banner-body">
                <b>Bots won’t survive a reboot yet.</b>A launchd LaunchAgent only runs after login.
                Enable auto-login for <code>{sys?.currentUser}</code> so your bots come back
                automatically when the Mac restarts.
                <div style={{ marginTop: 'var(--s2)' }}>
                  <button className="small" onClick={() => void api.openAutoLoginSettings()}>
                    Open Login settings
                  </button>
                </div>
              </div>
            </div>
          )}

          {selected ? (
            <BotDetail bot={selected} onChanged={() => void refresh()} />
          ) : (
            !loading && (
              <div className="empty">
                <div style={{ fontSize: 40 }}>🛰️</div>
                <h2>No bot selected</h2>
                <p>Import a Telegram bot to get it running 24/7.</p>
                <button className="primary" onClick={() => setShowImport(true)}>
                  + Import your first bot
                </button>
              </div>
            )
          )}
        </div>
      </main>

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={(bot) => {
            setShowImport(false)
            setSelectedId(bot.manifest.id)
            void refresh()
          }}
        />
      )}

      {showPrefs && <PreferencesModal onClose={() => { setShowPrefs(false); void refresh() }} />}
    </div>
  )
}

function FleetHeader({
  total,
  running,
  crashed,
  wantsReboot,
  rebootReady
}: {
  total: number
  running: number
  crashed: number
  wantsReboot: boolean
  rebootReady: boolean
}): React.ReactElement {
  const allUp = running === total
  const numClass = crashed > 0 ? 'err' : allUp ? 'ok' : ''
  return (
    <header className="fleet">
      <div className="fleet-count">
        <span className={`num ${numClass}`}>
          {running}/{total}
        </span>
        <span className="lbl">bots running</span>
      </div>
      <div className="fleet-pills">
        <span className="pill">
          <span className="dot running" /> {running} running
        </span>
        {crashed > 0 && (
          <span className="pill">
            <span className="dot crashed" /> {crashed} crashed
          </span>
        )}
        {total - running - crashed > 0 && (
          <span className="pill">
            <span className="dot stopped" /> {total - running - crashed} idle
          </span>
        )}
      </div>
      <span className="spacer" />
      {wantsReboot &&
        (rebootReady ? (
          <span className="fleet-reboot ok" title="Auto-login is on; bots restart after a reboot.">
            ✅ Reboot-ready
          </span>
        ) : (
          <button
            className="fleet-reboot warn"
            onClick={() => void api.openAutoLoginSettings()}
            title="Enable auto-login so bots survive a reboot"
          >
            ⚠️ Not reboot-safe
          </button>
        ))}
    </header>
  )
}

function labelFor(b: Bot): string {
  const s = b.runtime
  if (s.status === 'running') return `running · pid ${s.pid}`
  if (s.status === 'crashed') return `crashed · exit ${s.lastExitCode}`
  if (!s.envReady) return 'needs setup'
  if (!s.installed) return 'ready to start'
  return s.status
}

function SystemFoot({ sys, onChanged }: { sys: SystemInfo; onChanged: () => void }): React.ReactElement {
  async function toggleAppLaunch(on: boolean): Promise<void> {
    await api.setAppAutoLaunch(on)
    onChanged()
  }
  return (
    <div style={{ marginTop: 'var(--s3)', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>macOS {sys.macVersion}</span>
        <span>{sys.autoLoginUser ? 'auto-login ✓' : 'auto-login ✗'}</span>
      </div>
      <div style={{ marginTop: 'var(--s2)' }}>
        <Switch
          checked={sys.appAutoLaunch}
          onChange={(on) => void toggleAppLaunch(on)}
          label="Open Sentinel at login"
        />
      </div>
    </div>
  )
}
