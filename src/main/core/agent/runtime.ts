/**
 * The agent loop: feed the model the toolset, run the tools it calls, loop until
 * it stops calling tools. Read-only tools run freely; mutating tools pause for
 * the injected confirm() (propose-then-confirm). Plus inferEnvSpec() — the AI
 * fallback used when plain detection can't make sense of a bot's env.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { chatCompletion, type AgentProvider, type ChatMessage } from './provider'
import { TOOLS } from './tools'

export interface AgentEvents {
  onText?: (text: string) => void
  onTool?: (name: string, args: Record<string, unknown>) => void
  onToolResult?: (name: string, result: string) => void
  /** Required for mutating tools when allowWrites. Resolve true to proceed. */
  confirm?: (summary: string) => Promise<boolean>
}

export interface RunAgentOpts {
  provider: AgentProvider
  botId: string
  dir: string
  task: string
  allowWrites: boolean
  /** 'self' = editing Sentinel's own source (uses only dir-based file/command tools). */
  scope?: 'bot' | 'self'
  maxSteps?: number
  events?: AgentEvents
  /** Prior conversation turns (clean user/assistant text) for continuity. */
  history?: ChatMessage[]
  /** Abort signal — when aborted, the tool-calling loop halts cleanly. */
  signal?: AbortSignal
}

function systemPrompt(allowWrites: boolean, scope: 'bot' | 'self'): string {
  if (scope === 'self') {
    return [
      'You are Sentinel editing its OWN source code — an Electron + React + TypeScript app. Layout: main process in src/main (core logic in src/main/core), renderer in src/renderer, shared types in src/shared. Tests are vitest; build is electron-vite.',
      'You can read/list/search files, edit code, and run commands in the project root. Each edit/command is shown to the user with its diff for one-tap approval.',
      'Investigate before editing and keep changes minimal. After editing, run "npm run typecheck" (and "npm test" when relevant) to confirm it still compiles. Then tell the user to rebuild/restart Sentinel to apply.',
      'Do not break the build. Never print secrets.',
      'When done, give a short summary with no tool call.'
    ].join('\n')
  }
  return [
    'You are Sentinel, an operations agent that manages a single Python Telegram bot in a sandboxed project directory.',
    'You have tools to read/list/search files, read logs, check status, and (when permitted) edit the bot’s SOURCE CODE and config files, run commands, manage the venv, restart, and pull updates.',
    'Investigate with read tools before acting. Be concise. Explain what you find and what you changed.',
    'Never print secret values; .env contents are redacted for you. To obtain a secret value, tell the user to set it (do not invent one).',
    allowWrites
      ? 'You may edit code (write_file/edit_file) and run commands; each such action is shown to the user with its diff for one-tap approval before it runs. After changing code, restart the bot and check logs/status to verify your fix actually worked.'
      : 'You are in READ-ONLY mode: investigate and advise, but do not attempt to change anything.',
    'When done, give a short final summary with no tool call.'
  ].join('\n')
}

/** Run the tool-calling loop to completion; returns the final assistant text. */
export async function runAgent(o: RunAgentOpts): Promise<string> {
  const ctx = { botId: o.botId, dir: o.dir }
  const scope = o.scope ?? 'bot'
  // Allowed tools: drop mutating ones unless writes are allowed, and drop
  // bot-specific ones entirely when editing Sentinel's own source.
  const allowed = Object.values(TOOLS).filter((t) => {
    if (scope === 'self' && t.botScoped) return false
    return o.allowWrites || !t.mutating
  })
  const schemas = allowed.map((t) => t.schema)
  const byName = new Map(allowed.map((t) => [t.schema.function.name, t]))
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(o.allowWrites, scope) },
    // Prior turns (if any) give the agent continuity across invocations.
    ...(o.history ?? []),
    {
      role: 'user',
      content: scope === 'self' ? `Project dir: ${o.dir}\n\nTask: ${o.task}` : `Bot id: ${o.botId}\nProject dir: ${o.dir}\n\nTask: ${o.task}`
    }
  ]
  const maxSteps = o.maxSteps ?? 12
  let last = ''

  for (let step = 0; step < maxSteps; step++) {
    // Client disconnected (e.g. phone closed the SSE stream): stop the loop
    // cleanly so we don't keep making LLM calls / running tools with no client.
    if (o.signal?.aborted) return last
    const msg = await chatCompletion(o.provider, messages, schemas, o.signal)
    messages.push(msg)
    if (msg.content) {
      last = msg.content
      o.events?.onText?.(msg.content)
    }
    const calls = msg.tool_calls ?? []
    if (!calls.length) return last

    for (const call of calls) {
      let args: Record<string, unknown> = {}
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
      } catch {
        args = {}
      }
      const tool = byName.get(call.function.name)
      let result: string

      if (!tool) {
        result = `Unknown or unavailable tool: ${call.function.name}`
      } else {
        o.events?.onTool?.(call.function.name, args)
        if (tool.mutating && o.events?.confirm) {
          const ok = await o.events.confirm(tool.summary?.(args) ?? call.function.name)
          if (!ok) {
            result = 'User rejected this action.'
            o.events?.onToolResult?.(call.function.name, result)
            messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: result })
            continue
          }
        }
        try {
          result = await tool.run(args, ctx)
        } catch (e) {
          result = `Error: ${(e as Error).message}`
        }
      }
      o.events?.onToolResult?.(call.function.name, result)
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: result.slice(0, 8000) })
    }
  }
  return last || 'Reached the step limit before finishing.'
}

// ---- AI env understanding (fallback when detection is empty/ambiguous) ------

export interface EnvVarSpec {
  key: string
  description: string
  secret: boolean
}

/** Pull together the signals an LLM needs to reason about a project's env. */
export function gatherEnvContext(dir: string): string {
  const parts: string[] = []
  const read = (f: string): string => {
    try {
      return readFileSync(join(dir, f), 'utf8')
    } catch {
      return ''
    }
  }
  for (const f of ['.env.example', '.env.sample', 'README.md', 'readme.md']) {
    const t = read(f)
    if (t) parts.push(`--- ${f} ---\n${t.slice(0, 2500)}`)
  }
  // Scan a few python files for os.environ / getenv usage.
  const hits: string[] = []
  const scan = (d: string, depth: number): void => {
    if (depth > 2 || hits.length > 40) return
    let names: string[] = []
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('.') || ['node_modules', '.venv', 'venv', '__pycache__'].includes(name)) continue
      const full = join(d, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) scan(full, depth + 1)
      else if (name.endsWith('.py')) {
        const text = read(full.slice(dir.length + 1))
        for (const line of text.split('\n')) {
          if (/environ|getenv|config\(|os\.getenv|dotenv/i.test(line)) hits.push(line.trim().slice(0, 160))
          if (hits.length > 40) break
        }
      }
    }
  }
  scan(dir, 0)
  if (hits.length) parts.push(`--- env usage in code ---\n${hits.join('\n')}`)
  return parts.join('\n\n').slice(0, 8000) || '(no obvious env hints found)'
}

/** Extract the first JSON array from a possibly chatty model response. */
export function extractJsonArray(text: string): unknown[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Ask the AI to describe the env vars a bot needs (used by the Telegram setup
 * wizard). knownKeys seeds it; if empty, the model infers from code/README.
 */
export async function inferEnvSpec(
  provider: AgentProvider,
  dir: string,
  knownKeys: string[]
): Promise<EnvVarSpec[]> {
  const context = gatherEnvContext(dir)
  const system =
    'You analyze a Python project and list the environment variables it needs. ' +
    'Respond with ONLY a JSON array of objects {"key": string, "description": short human guidance on what to enter, "secret": boolean}. ' +
    'Mark tokens, API keys/ids/hashes, passwords and session strings as secret. No prose outside the JSON.'
  const user = `Known keys (may be incomplete or empty): ${knownKeys.join(', ') || '(none)'}\n\nProject context:\n${context}`
  const msg = await chatCompletion(provider, [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ])
  const arr = extractJsonArray(msg.content ?? '')
  const specs: EnvVarSpec[] = []
  for (const item of arr) {
    const o = item as Record<string, unknown>
    const key = typeof o.key === 'string' ? o.key.trim() : ''
    if (!key) continue
    specs.push({
      key,
      description: typeof o.description === 'string' ? o.description : 'Set this environment variable.',
      secret: o.secret === true || /TOKEN|HASH|SECRET|PASSWORD|KEY|API_ID|SESSION/i.test(key)
    })
  }
  return specs
}

export function venvBinExists(dir: string): boolean {
  return existsSync(join(dir, '.venv', 'bin', 'python'))
}
