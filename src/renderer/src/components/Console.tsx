import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { StreamChunk } from '@shared/types'

// Strip common ANSI escape sequences so PTY output reads cleanly.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

const ERR = /\b(error|traceback|exception|critical|fatal|fail(ed|ure)?)\b|^\s+File ".*", line/i
const WARN = /\b(warn(ing)?|deprecat)/i

function levelOf(line: string): 'err' | 'warn' | '' {
  if (ERR.test(line)) return 'err'
  if (WARN.test(line)) return 'warn'
  return ''
}

interface Props {
  botId: string
  channel: StreamChunk['channel']
  /** Reset the buffer when this value changes (e.g. a new run). */
  resetKey?: string | number
  short?: boolean
  /** Initial text to seed the buffer with. */
  seed?: string
}

/** A scrolling, append-only console fed by the main process stream events. */
export function Console({ botId, channel, resetKey, short, seed }: Props): React.ReactElement {
  const [text, setText] = useState(seed ?? '')
  const [wrap, setWrap] = useState(true)
  const [pinned, setPinned] = useState(true)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  useEffect(() => {
    setText(seed ?? '')
  }, [resetKey, seed])

  useEffect(() => {
    return api.onStream((chunk: StreamChunk) => {
      if (chunk.channel !== channel) return
      // Import streams under botId '' — show those too when our botId is ''.
      if (chunk.botId !== botId) return
      setText((t) => (t + chunk.data.replace(ANSI, '')).slice(-200_000))
    })
  }, [botId, channel])

  useEffect(() => {
    const el = ref.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [text])

  function onScroll(): void {
    const el = ref.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    atBottom.current = bottom
    setPinned(bottom)
  }

  function jump(): void {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottom.current = true
    setPinned(true)
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable */
    }
  }

  const lines = useMemo(() => text.split('\n'), [text])

  return (
    <div className="console-wrap">
      <div className="console-toolbar">
        <button className={wrap ? 'on' : ''} onClick={() => setWrap((w) => !w)} title="Toggle line wrap">
          {wrap ? 'Wrap' : 'No wrap'}
        </button>
        <span className="spacer" />
        <button onClick={() => void copy()} disabled={!text}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
        <button onClick={() => setText('')} disabled={!text} title="Clear this view">
          Clear
        </button>
      </div>
      <div
        className={`console${short ? ' short' : ''}${wrap ? '' : ' nowrap'}`}
        ref={ref}
        onScroll={onScroll}
        role="log"
        aria-label="Console output"
      >
        {text ? (
          lines.map((ln, i) => (
            <span key={i} className={`ln ${levelOf(ln)}`}>
              {ln + '\n'}
            </span>
          ))
        ) : (
          <span className="console-empty">Waiting for output…</span>
        )}
      </div>
      {!pinned && (
        <button className="jump-bottom" onClick={jump}>
          ↓ Jump to latest
        </button>
      )}
    </div>
  )
}
