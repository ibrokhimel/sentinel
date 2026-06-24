import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpsRequest } from 'node:https'

/**
 * Minimal OpenAI-compatible chat-completions client with tool-calling. Works
 * against OpenAI, OpenRouter, Together, local servers, etc. — anything that
 * speaks POST {baseUrl}/chat/completions. No SDK; just fetch.
 */

export interface AgentProvider {
  /** e.g. https://openrouter.ai/api/v1 (no trailing /chat/completions). */
  baseUrl: string
  apiKey: string
  model: string
}

export interface ToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

type JsonResponse = {
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<unknown>
}

function postJsonFallback(url: string, headers: Record<string, string>, body: string, signal?: AbortSignal): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = httpsRequest(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        port: u.port || 443,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        timeout: 25_000
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            text: async () => text,
            json: async () => JSON.parse(text)
          })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('https request timeout')))
    req.on('error', reject)
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('aborted'))
        return
      }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    }
    req.end(body)
  })
}

async function postJsonCurl(url: string, headers: Record<string, string>, body: string, signal?: AbortSignal): Promise<JsonResponse> {
  const dir = await mkdtemp(join(tmpdir(), 'sentinel-ai-'))
  try {
    const bodyPath = join(dir, 'body.json')
    const cfgPath = join(dir, 'curl.conf')
    const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const cfg = [
      'silent',
      'show-error',
      'location',
      'request = "POST"',
      'max-time = 30',
      'connect-timeout = 15',
      `url = "${esc(url)}"`,
      `data-binary = "@${esc(bodyPath)}"`,
      ...Object.entries(headers).map(([k, v]) => `header = "${esc(k)}: ${esc(v)}"`),
      'write-out = "\\n%{http_code}"'
    ].join('\n')
    await writeFile(bodyPath, body, { mode: 0o600 })
    await writeFile(cfgPath, cfg, { mode: 0o600 })
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile('/usr/bin/curl', ['--config', cfgPath], { timeout: 35_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message))
        else resolve(stdout)
      })
      if (signal) {
        if (signal.aborted) child.kill()
        else signal.addEventListener('abort', () => child.kill(), { once: true })
      }
    })
    const cut = out.lastIndexOf('\n')
    const text = cut >= 0 ? out.slice(0, cut) : out
    const status = cut >= 0 ? Number(out.slice(cut + 1).trim()) || 0 : 0
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** One round-trip. Returns the assistant message (may contain tool_calls). */
export async function chatCompletion(
  p: AgentProvider,
  messages: ChatMessage[],
  tools?: ToolSchema[],
  signal?: AbortSignal
): Promise<ChatMessage> {
  const url = p.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  let res: JsonResponse | Response
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${p.apiKey}`,
    // OpenRouter is happier with these; harmless elsewhere.
    'HTTP-Referer': 'https://github.com/sentinel',
    'X-Title': 'Sentinel'
  }
  const body = JSON.stringify({
    model: p.model,
    messages,
    tools: tools && tools.length ? tools : undefined,
    tool_choice: tools && tools.length ? 'auto' : undefined,
    temperature: 0.2
  })
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal })
  } catch (e) {
    try {
      res = await postJsonFallback(url, headers, body, signal)
    } catch {
      try {
        res = await postJsonCurl(url, headers, body, signal)
      } catch {
        const err = e as Error & { cause?: { code?: string; message?: string } }
        const detail = err.cause?.code || err.cause?.message || err.message
        throw new Error(`AI network request failed: ${detail}`)
      }
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`AI request failed (${res.status}): ${body.slice(0, 300)}`)
  }
  const json = (await res.json()) as { choices?: Array<{ message?: ChatMessage }> }
  const msg = json.choices?.[0]?.message
  if (!msg) throw new Error('AI returned no message')
  return msg
}

/**
 * Streaming completion (no tools). Calls onText with the growing full text as
 * deltas arrive; returns the final text. Used by the live "cooking…" chat.
 */
export async function chatStream(
  p: AgentProvider,
  messages: ChatMessage[],
  onText: (full: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const url = p.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`,
        'HTTP-Referer': 'https://github.com/sentinel',
        'X-Title': 'Sentinel'
      },
      body: JSON.stringify({ model: p.model, messages, stream: true, temperature: 0.4 }),
      signal
    })
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } }
    const detail = err.cause?.code || err.cause?.message || err.message
    throw new Error(`AI network request failed: ${detail}`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`AI request failed (${res.status}): ${body.slice(0, 300)}`)
  }
  if (!res.body) {
    // Provider didn't stream — fall back to a single completion.
    const m = await chatCompletion(p, messages)
    const t = m.content ?? ''
    onText(t)
    return t
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const j = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
        const delta = j.choices?.[0]?.delta?.content
        if (delta) {
          full += delta
          onText(full)
        }
      } catch {
        /* keep-alive or partial frame — ignore */
      }
    }
  }
  return full
}

/** Cheap validity check for the Test button — one tiny completion. */
export async function ping(p: AgentProvider): Promise<boolean> {
  try {
    const msg = await chatCompletion(p, [{ role: 'user', content: 'Reply with the single word OK.' }])
    return typeof msg.content === 'string'
  } catch {
    return false
  }
}
