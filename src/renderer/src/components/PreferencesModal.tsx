import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AppConfig } from '@shared/types'
import { Switch } from './Switch'

interface Props {
  onClose: () => void
}

export function PreferencesModal({ onClose }: Props): React.ReactElement {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [chatId, setChatId] = useState('')
  const [token, setToken] = useState('')
  const [savingNotify, setSavingNotify] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const [busyAgent, setBusyAgent] = useState(false)
  // AI provider fields
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [aiKey, setAiKey] = useState('')
  const [savingAi, setSavingAi] = useState(false)
  const [aiMsg, setAiMsg] = useState('')
  const [ghToken, setGhToken] = useState('')
  const [savingGh, setSavingGh] = useState(false)

  useEffect(() => {
    void (async () => {
      const c = await api.getConfig()
      setCfg(c)
      setChatId(c.notify.chatId)
      setBaseUrl(c.agent.baseUrl)
      setModel(c.agent.model)
    })()
  }, [])

  if (!cfg) {
    return (
      <div className="overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          Loading…
        </div>
      </div>
    )
  }

  async function saveNotify(): Promise<void> {
    setSavingNotify(true)
    setTestMsg('')
    try {
      const next = await api.setNotify({
        chatId,
        // Only send the token if the user typed a new one; '' clears it.
        token: token.length ? token : undefined
      })
      setCfg(next)
      setToken('')
    } finally {
      setSavingNotify(false)
    }
  }

  async function toggleNotifyEnabled(on: boolean): Promise<void> {
    setCfg(await api.setNotify({ enabled: on }))
  }

  async function test(): Promise<void> {
    setTestMsg('Sending…')
    const ok = await api.testNotify()
    setTestMsg(ok ? 'Sent — check Telegram ✓' : 'Failed — check token + chat id, and press Start on the bot once.')
  }

  async function toggleAutoUpdate(on: boolean): Promise<void> {
    setCfg(await api.setAutoUpdate(on))
  }

  async function toggleControl(on: boolean): Promise<void> {
    setCfg(await api.setControl(on))
  }

  async function saveAi(): Promise<void> {
    setSavingAi(true)
    setAiMsg('')
    try {
      const next = await api.setAgent({ baseUrl, model, key: aiKey.length ? aiKey : undefined })
      setCfg(next)
      setAiKey('')
    } finally {
      setSavingAi(false)
    }
  }

  async function testAi(): Promise<void> {
    setAiMsg('Testing…')
    const ok = await api.testAgent()
    setAiMsg(ok ? 'Works — model responded ✓' : 'Failed — check base URL, model, and key.')
  }

  async function saveGithub(): Promise<void> {
    setSavingGh(true)
    try {
      setCfg(await api.setGithubToken(ghToken))
      setGhToken('')
    } finally {
      setSavingGh(false)
    }
  }

  async function toggleAgent(on: boolean): Promise<void> {
    setBusyAgent(true)
    try {
      setCfg(await api.setBackgroundAgent(on))
    } catch (e) {
      setTestMsg(String((e as Error).message ?? e))
    } finally {
      setBusyAgent(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Preferences</h2>
        <p className="sub">Notifications, auto-update, and always-on supervision.</p>

        <div className="card">
          <h3>Telegram crash alerts</h3>
          <p className="note">
            Sentinel DMs you when a bot crashes or crash-loops. Create a bot with @BotFather, paste its token,
            and put your numeric chat id (DM the bot once first).
          </p>
          <div style={{ margin: '10px 0' }}>
            <Switch checked={cfg.notify.enabled} onChange={(v) => void toggleNotifyEnabled(v)} label="Enable Telegram alerts" />
          </div>
          <label className="field">
            <span>Notifier bot token {cfg.notify.hasToken && <span className="badge ok">stored</span>}</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={cfg.notify.hasToken ? '•••••••• (leave blank to keep)' : '123456:ABC-DEF…'}
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>Your chat id</span>
            <input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="123456789" spellCheck={false} />
          </label>
          <div className="row" style={{ gap: 8 }}>
            <button className="primary small" onClick={() => void saveNotify()} disabled={savingNotify}>
              {savingNotify ? 'Saving…' : 'Save'}
            </button>
            <button className="small" onClick={() => void test()} disabled={!cfg.notify.hasToken || !cfg.notify.chatId}>
              Send test
            </button>
            {testMsg && <span className="note" style={{ margin: 0 }}>{testMsg}</span>}
          </div>
        </div>

        <div className="card">
          <h3>Telegram remote control</h3>
          <p className="note">
            Turns the <b>same bot</b> into a remote: from your Telegram chat you can run <code>/status</code>,{' '}
            <code>/list</code>, and start / stop / restart / update bots and read logs — tappable buttons included.
            Only your chat id (above) is allowed to issue commands.
          </p>
          <div style={{ margin: '10px 0' }}>
            <Switch
              checked={cfg.control.enabled}
              onChange={(v) => void toggleControl(v)}
              disabled={!cfg.control.ready}
              label={cfg.control.enabled ? 'Remote control on' : 'Enable remote control'}
            />
          </div>
          {!cfg.control.ready ? (
            <p className="note" style={{ color: 'var(--warning)' }}>
              Set the bot token and your chat id above first, then enable this.
            </p>
          ) : (
            <p className="note">
              {cfg.backgroundAgent
                ? 'Served by the always-on agent — works even when this window is closed.'
                : 'Runs while Sentinel is open. Turn on “Always-on supervision” below to keep it 24/7.'}
            </p>
          )}
        </div>

        <div className="card">
          <h3>AI agent {cfg.agent.ready && <span className="badge ok">ready</span>}</h3>
          <p className="note">
            An OpenAI-compatible endpoint powers the bot’s agent (<code>/ask</code>, <code>/fix</code>,{' '}
            <code>/setup</code> in Telegram) — it can read logs and files, run commands, and fix bots, asking you to
            approve each change. You can also set this from Telegram with <code>/setai</code>.
          </p>
          <label className="field">
            <span>Base URL</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://openrouter.ai/api/v1"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>Model</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. openai/gpt-4o-mini"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>API key {cfg.agent.hasKey && <span className="badge ok">stored</span>}</span>
            <input
              type="password"
              value={aiKey}
              onChange={(e) => setAiKey(e.target.value)}
              placeholder={cfg.agent.hasKey ? '•••••••• (leave blank to keep)' : 'sk-…'}
              spellCheck={false}
            />
          </label>
          <div className="row" style={{ gap: 8 }}>
            <button className="primary small" onClick={() => void saveAi()} disabled={savingAi}>
              {savingAi ? 'Saving…' : 'Save'}
            </button>
            <button className="small" onClick={() => void testAi()} disabled={!cfg.agent.ready}>
              Test
            </button>
            {aiMsg && (
              <span className="note" style={{ margin: 0 }}>
                {aiMsg}
              </span>
            )}
          </div>
        </div>

        <div className="card">
          <h3>GitHub auto-update</h3>
          <div style={{ marginBottom: 8 }}>
            <Switch checked={cfg.autoUpdateEnabled} onChange={(v) => void toggleAutoUpdate(v)}
              label="Enable scheduled auto-update (per-bot toggle also required)" />
          </div>
          <p className="note">When on, bots with auto-update pull from GitHub on their interval, reinstall deps if changed, and restart.</p>
          <label className="field" style={{ marginTop: 10 }}>
            <span>GitHub token {cfg.hasGithubToken && <span className="badge ok">stored</span>}</span>
            <input
              type="password"
              value={ghToken}
              onChange={(e) => setGhToken(e.target.value)}
              placeholder={cfg.hasGithubToken ? '•••••••• (leave blank to keep)' : 'ghp_… (push access)'}
              spellCheck={false}
            />
          </label>
          <p className="note">Used by “Push → sentinel-live” to push a bot’s current files (including AI edits) to GitHub.</p>
          <div className="row-actions">
            <button className="primary small" onClick={() => void saveGithub()} disabled={savingGh || !ghToken.length}>
              {savingGh ? 'Saving…' : 'Save token'}
            </button>
            {cfg.hasGithubToken && (
              <button className="small" onClick={() => void api.setGithubToken('').then(setCfg)} disabled={savingGh}>
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="card">
          <h3>Always-on supervision</h3>
          <p className="note">
            Installs a background launchd agent so crash-loop give-up, alerts, and auto-update keep working even
            when this window is closed. Without it, supervision only runs while Sentinel is open.
          </p>
          <div style={{ marginTop: 8 }}>
            <Switch checked={cfg.backgroundAgent} onChange={(v) => void toggleAgent(v)} disabled={busyAgent}
              label={cfg.backgroundAgent ? 'Background agent installed' : 'Install background agent'} />
          </div>
        </div>

        <div className="modal-actions">
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
