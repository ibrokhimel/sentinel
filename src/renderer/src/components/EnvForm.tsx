import { useEffect, useState } from 'react'
import { api } from '../api'

interface Props {
  botId: string
  onSaved?: () => void
}

const SECRET_HINT = /(TOKEN|HASH|SECRET|PASSWORD|KEY|API_ID|SESSION)/i

/** Form for the bot's .env keys, seeded from .env.example and current values. */
export function EnvForm({ botId, onSaved }: Props): React.ReactElement {
  const [keys, setKeys] = useState<string[]>([])
  const [example, setExample] = useState<Record<string, string>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [newKey, setNewKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId])

  async function load(): Promise<void> {
    const env = await api.getEnv(botId)
    setKeys(env.keys)
    setExample(env.example)
    setValues(env.current)
  }

  function set(k: string, v: string): void {
    setValues((prev) => ({ ...prev, [k]: v }))
    setSaved(false)
  }

  function addKey(): void {
    const k = newKey.trim().toUpperCase()
    if (k && !keys.includes(k)) {
      setKeys((prev) => [...prev, k])
      setValues((prev) => ({ ...prev, [k]: '' }))
    }
    setNewKey('')
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      // Only persist keys we know about (drop empties? keep them for clarity).
      const payload: Record<string, string> = {}
      for (const k of keys) payload[k] = values[k] ?? ''
      await api.saveEnv(botId, payload)
      setSaved(true)
      onSaved?.()
    } finally {
      setSaving(false)
    }
  }

  if (keys.length === 0) {
    return (
      <div>
        <p className="note">
          No environment keys detected. If this bot needs secrets (API keys, tokens), add them below.
        </p>
        <AddKey newKey={newKey} setNewKey={setNewKey} addKey={addKey} />
      </div>
    )
  }

  return (
    <div>
      {keys.map((k) => (
        <label className="field" key={k}>
          <span>
            {k}{' '}
            {example[k] ? <span className="tag">e.g. {String(example[k]).slice(0, 40)}</span> : null}
          </span>
          <input
            type={SECRET_HINT.test(k) ? 'password' : 'text'}
            value={values[k] ?? ''}
            placeholder={example[k] ? String(example[k]) : ''}
            onChange={(e) => set(k, e.target.value)}
            spellCheck={false}
          />
        </label>
      ))}
      <AddKey newKey={newKey} setNewKey={setNewKey} addKey={addKey} />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save .env'}
        </button>
        {saved && <span className="badge ok">Saved (chmod 600)</span>}
      </div>
    </div>
  )
}

function AddKey({
  newKey,
  setNewKey,
  addKey
}: {
  newKey: string
  setNewKey: (s: string) => void
  addKey: () => void
}): React.ReactElement {
  return (
    <div className="login-input">
      <input
        placeholder="ADD_KEY_NAME"
        value={newKey}
        onChange={(e) => setNewKey(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && addKey()}
        spellCheck={false}
      />
      <button className="small" onClick={addKey}>
        Add key
      </button>
    </div>
  )
}
