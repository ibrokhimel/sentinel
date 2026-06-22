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

/** One round-trip. Returns the assistant message (may contain tool_calls). */
export async function chatCompletion(
  p: AgentProvider,
  messages: ChatMessage[],
  tools?: ToolSchema[],
  signal?: AbortSignal
): Promise<ChatMessage> {
  const url = p.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${p.apiKey}`,
      // OpenRouter is happier with these; harmless elsewhere.
      'HTTP-Referer': 'https://github.com/sentinel',
      'X-Title': 'Sentinel'
    },
    body: JSON.stringify({
      model: p.model,
      messages,
      tools: tools && tools.length ? tools : undefined,
      tool_choice: tools && tools.length ? 'auto' : undefined,
      temperature: 0.2
    }),
    signal
  })
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
  const res = await fetch(url, {
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
