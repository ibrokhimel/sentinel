import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Console } from './Console'
import type { Bot } from '@shared/types'

interface Props {
  onClose: () => void
  onImported: (bot: Bot) => void
}

type Mode = 'local' | 'git'

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function ImportModal({ onClose, onImported }: Props): React.ReactElement {
  const modalRef = useRef<HTMLDivElement>(null)

  // Autofocus first field; trap Tab inside the modal; Esc closes.
  useEffect(() => {
    const focusables = modalRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
    focusables?.[0]?.focus()
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !modalRef.current) return
      const items = Array.from(modalRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const [mode, setMode] = useState<Mode>('local')
  const [folder, setFolder] = useState('')
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)

  async function pick(): Promise<void> {
    const f = await api.pickFolder()
    if (f) {
      setFolder(f)
      if (!name) setName(f.split('/').pop() ?? '')
    }
  }

  const canImport = mode === 'local' ? folder.length > 0 : /^https?:\/\/.+/.test(url)

  async function doImport(): Promise<void> {
    setBusy(true)
    setRunning(true)
    setError('')
    try {
      const req =
        mode === 'local'
          ? { type: 'local' as const, source: folder, name: name || undefined }
          : { type: 'git' as const, source: url, name: name || undefined, token: token || undefined }
      const { bot } = await api.importBot(req)
      onImported(bot)
    } catch (e) {
      setError(String((e as Error).message ?? e))
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Import a bot"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Import a bot</h2>
        <p className="sub">
          The bot’s files are copied into <code>~/Documents/Sentinel/bots/</code>. Sentinel auto-detects
          how to run it; you can edit anything afterwards.
        </p>

        <div className="seg" style={{ marginBottom: 16 }}>
          <button className={mode === 'local' ? 'on' : ''} onClick={() => setMode('local')} disabled={running}>
            Local folder
          </button>
          <button className={mode === 'git' ? 'on' : ''} onClick={() => setMode('git')} disabled={running}>
            GitHub
          </button>
        </div>

        {mode === 'local' ? (
          <label className="field">
            <span>Project folder</span>
            <div className="login-input">
              <input value={folder} readOnly placeholder="Choose a folder…" />
              <button className="small" onClick={() => void pick()} disabled={running}>
                Browse…
              </button>
            </div>
          </label>
        ) : (
          <>
            <label className="field">
              <span>Repository URL</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
                spellCheck={false}
                disabled={running}
              />
            </label>
            <label className="field">
              <span>Personal access token (private repos only — not stored)</span>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_…"
                spellCheck={false}
                disabled={running}
              />
            </label>
          </>
        )}

        <label className="field">
          <span>Display name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My bot" disabled={running} />
        </label>

        {running && <Console botId="" channel="setup" short />}
        {error && <div className="err-text">{error}</div>}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose} disabled={busy && !error}>
            {running && !error ? 'Working…' : 'Cancel'}
          </button>
          <button className="primary" onClick={() => void doImport()} disabled={!canImport || busy}>
            Import
          </button>
        </div>
      </div>
    </div>
  )
}
