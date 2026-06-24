/**
 * The agent's toolbox — Claude-Code-style file/command/git/supervisor tools,
 * every one sandboxed to a single bot's directory. Read tools run freely; the
 * `mutating` ones are gated by the runtime's confirm() callback.
 *
 * Secret hygiene: file contents that look like a .env are redacted before they
 * ever reach the model — the agent sees which keys exist, never their values.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { exec } from '../exec'
import { botLogPaths } from '../paths'
import { checkForUpdates } from '../git'
import * as sup from '../supervisor'
import { tailBotLogs } from '../telegramBot'
import type { ToolSchema } from './provider'

export interface ToolContext {
  botId: string
  dir: string
}

export interface Tool {
  schema: ToolSchema
  mutating: boolean
  /** Needs a real managed bot (status/logs/env/launchd) — excluded in self-edit mode. */
  botScoped?: boolean
  /** Cross-bot, read-only fleet tool (takes an explicit botId, not ctx.dir). */
  fleet?: boolean
  summary?: (args: Record<string, unknown>) => string
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>
}

const SKIP_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'])
const MAX_OUT = 8000

/** Resolve a relative path and refuse anything that escapes the bot dir. */
export function safeResolve(dir: string, rel: string): string {
  const base = resolve(dir)
  const p = resolve(base, rel ?? '.')
  if (p !== base && !p.startsWith(base + '/')) {
    throw new Error(`Path "${rel}" escapes the bot directory`)
  }
  return p
}

/** Mask the values of a .env-style body so secrets never reach the model. */
export function redactEnv(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*[A-Za-z_][A-Za-z0-9_]*\s*=)(.*)$/)
      if (!m) return line
      return m[2].trim() ? `${m[1]}<set, hidden>` : line
    })
    .join('\n')
}

function isEnvFile(rel: string): boolean {
  return /(^|\/)\.env(\.|$)/.test(rel) && !/\.example$|\.sample$/.test(rel)
}

function walk(dir: string, base: string, out: string[], depth: number): void {
  if (out.length >= 400 || depth > 6) return
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith('.') && name !== '.env.example') continue
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    const rel = full.slice(base.length + 1)
    if (st.isDirectory()) {
      out.push(rel + '/')
      walk(full, base, out, depth + 1)
    } else {
      out.push(rel)
    }
    if (out.length >= 400) return
  }
}

function clip(s: string): string {
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + '\n…(truncated)' : s
}

/** Short preview of proposed file content/diff, for the approval message. */
function preview(s: string, max = 700): string {
  const t = s.length > max ? s.slice(0, max) + '\n…(truncated)' : s
  return t || '(empty)'
}

export const TOOLS: Record<string, Tool> = {
  list_files: {
    mutating: false,
    schema: {
      type: 'function',
      function: {
        name: 'list_files',
        description: "List files in the bot's project directory (recursive, skipping venv/git/caches).",
        parameters: { type: 'object', properties: { subdir: { type: 'string', description: 'Optional sub-path' } } }
      }
    },
    run: async (args, ctx) => {
      const start = args.subdir ? safeResolve(ctx.dir, String(args.subdir)) : resolve(ctx.dir)
      const out: string[] = []
      walk(start, resolve(ctx.dir), out, 0)
      return clip(out.join('\n') || '(empty)')
    }
  },

  read_file: {
    mutating: false,
    schema: {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a UTF-8 text file from the bot directory. .env values are redacted.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
      }
    },
    run: async (args, ctx) => {
      const rel = String(args.path ?? '')
      const p = safeResolve(ctx.dir, rel)
      if (!existsSync(p)) return `File not found: ${rel}`
      let text = readFileSync(p, 'utf8')
      if (isEnvFile(rel)) text = redactEnv(text)
      return clip(text || '(empty file)')
    }
  },

  write_file: {
    mutating: true,
    summary: (a) =>
      `Write ${a.path} (${String(a.content ?? '').length} bytes):\n${preview(String(a.content ?? ''))}`,
    schema: {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or overwrite a text file (including source code) in the bot directory.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content']
        }
      }
    },
    run: async (args, ctx) => {
      const rel = String(args.path ?? '')
      const p = safeResolve(ctx.dir, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, String(args.content ?? ''), 'utf8')
      return `Wrote ${rel} (${String(args.content ?? '').length} bytes).`
    }
  },

  edit_file: {
    mutating: true,
    summary: (a) =>
      `Edit ${a.path}\n--- replace ---\n${preview(String(a.old_text ?? ''), 400)}\n--- with ---\n${preview(String(a.new_text ?? ''), 400)}`,
    schema: {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Replace the first exact occurrence of old_text with new_text in a file (e.g. fix a bug in source code).',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
          required: ['path', 'old_text', 'new_text']
        }
      }
    },
    run: async (args, ctx) => {
      const rel = String(args.path ?? '')
      const p = safeResolve(ctx.dir, rel)
      if (!existsSync(p)) return `File not found: ${rel}`
      const text = readFileSync(p, 'utf8')
      const oldT = String(args.old_text ?? '')
      if (!text.includes(oldT)) return `old_text not found in ${rel} — read the file again.`
      writeFileSync(p, text.replace(oldT, String(args.new_text ?? '')), 'utf8')
      return `Edited ${rel}.`
    }
  },

  search_code: {
    mutating: false,
    schema: {
      type: 'function',
      function: {
        name: 'search_code',
        description: 'Search the bot directory for a string/regex (like grep -rn).',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
      }
    },
    run: async (args, ctx) => {
      const q = String(args.query ?? '')
      if (!q) return 'Empty query.'
      const r = await exec(
        'grep',
        ['-rnI', '--exclude-dir=.git', '--exclude-dir=.venv', '--exclude-dir=node_modules', '--exclude-dir=__pycache__', q, '.'],
        { cwd: ctx.dir }
      )
      const lines = (r.stdout || '').split('\n').slice(0, 80).join('\n')
      return clip(lines || '(no matches)')
    }
  },

  run_command: {
    mutating: true,
    summary: (a) => `Run: ${a.command}`,
    schema: {
      type: 'function',
      function: {
        name: 'run_command',
        description: "Run a shell command in the bot directory with its venv on PATH. 120s timeout. Use for pip, tests, scripts.",
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
      }
    },
    run: async (args, ctx) => {
      const command = String(args.command ?? '')
      if (!command) return 'Empty command.'
      const venvBin = join(ctx.dir, '.venv', 'bin')
      const r = await exec('/bin/bash', ['-lc', command], {
        cwd: ctx.dir,
        timeout: 120_000,
        env: { ...process.env, PATH: `${venvBin}:${process.env.PATH ?? ''}`, VIRTUAL_ENV: join(ctx.dir, '.venv') }
      })
      const body = `exit=${r.code}\n${r.stdout}${r.stderr}`
      return clip(body)
    }
  },

  read_logs: {
    mutating: false,
    botScoped: true,
    schema: {
      type: 'function',
      function: {
        name: 'read_logs',
        description: "Read the last N lines of the bot's stdout+stderr logs.",
        parameters: { type: 'object', properties: { lines: { type: 'number' } } }
      }
    },
    run: async (args, ctx) => {
      const n = Math.min(200, Math.max(1, Number(args.lines) || 60))
      const { out, err } = botLogPaths(ctx.botId)
      const read = (p: string): string => {
        try {
          return existsSync(p) ? readFileSync(p, 'utf8') : ''
        } catch {
          return ''
        }
      }
      const all = (read(out) + read(err)).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').filter(Boolean)
      return clip(all.slice(-n).join('\n') || '(no logs yet)')
    }
  },

  get_status: {
    mutating: false,
    botScoped: true,
    schema: {
      type: 'function',
      function: {
        name: 'get_status',
        description: 'Get the live runtime status of the bot (status, pid, restarts, env readiness).',
        parameters: { type: 'object', properties: {} }
      }
    },
    run: async (_args, ctx) => {
      const b = await sup.getBot(ctx.botId)
      return JSON.stringify({ name: b.manifest.name, ...b.runtime, framework: b.manifest.framework }, null, 2)
    }
  },

  read_env_example: {
    mutating: false,
    botScoped: true,
    schema: {
      type: 'function',
      function: {
        name: 'read_env_example',
        description: 'List the env keys this bot expects, with example placeholder values, and which are currently set.',
        parameters: { type: 'object', properties: {} }
      }
    },
    run: async (_args, ctx) => {
      const env = sup.getEnv(ctx.botId)
      const rows = env.keys.map((k) => ({ key: k, example: env.example[k] ?? '', set: !!env.current[k] }))
      return JSON.stringify(rows, null, 2)
    }
  },

  set_env: {
    mutating: true,
    botScoped: true,
    summary: (a) => `Set env ${a.key}`,
    schema: {
      type: 'function',
      function: {
        name: 'set_env',
        description: 'Set a single non-secret env var. For secret values, ask the user to set them instead.',
        parameters: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] }
      }
    },
    run: async (args, ctx) => {
      const key = String(args.key ?? '').trim()
      if (!key) return 'Missing key.'
      const env = sup.getEnv(ctx.botId)
      await sup.saveEnv(ctx.botId, { ...env.current, [key]: String(args.value ?? '') })
      return `Set ${key}.`
    }
  },

  setup_env: {
    mutating: true,
    botScoped: true,
    summary: () => 'Create the venv and install dependencies',
    schema: {
      type: 'function',
      function: {
        name: 'setup_env',
        description: 'Create the virtualenv and install the bot dependencies.',
        parameters: { type: 'object', properties: {} }
      }
    },
    run: async (_args, ctx) => {
      let log = ''
      await sup.setupBotEnv(ctx.botId, (s) => {
        log += s
      })
      return clip(log || 'Environment set up.')
    }
  },

  restart_bot: {
    mutating: true,
    botScoped: true,
    summary: () => 'Restart the bot',
    schema: {
      type: 'function',
      function: { name: 'restart_bot', description: 'Restart the bot via launchd.', parameters: { type: 'object', properties: {} } }
    },
    run: async (_args, ctx) => {
      const b = await sup.restart(ctx.botId)
      return `Restarted — status: ${b.runtime.status}.`
    }
  },

  stop_bot: {
    mutating: true,
    botScoped: true,
    summary: () => 'Stop the bot',
    schema: {
      type: 'function',
      function: { name: 'stop_bot', description: 'Stop the bot.', parameters: { type: 'object', properties: {} } }
    },
    run: async (_args, ctx) => {
      const b = await sup.stop(ctx.botId)
      return `Stopped — status: ${b.runtime.status}.`
    }
  },

  start_bot: {
    mutating: true,
    botScoped: true,
    summary: () => 'Start the bot 24/7',
    schema: {
      type: 'function',
      function: { name: 'start_bot', description: 'Install the launchd agent and start the bot.', parameters: { type: 'object', properties: {} } }
    },
    run: async (_args, ctx) => {
      const b = await sup.start(ctx.botId)
      return `Started — status: ${b.runtime.status}.`
    }
  },

  check_updates: {
    mutating: false,
    botScoped: true,
    schema: {
      type: 'function',
      function: { name: 'check_updates', description: 'Check how many commits behind origin the bot is (git bots).', parameters: { type: 'object', properties: {} } }
    },
    run: async (_args, ctx) => {
      const b = await sup.getBot(ctx.botId)
      const c = await checkForUpdates(b.dir)
      return JSON.stringify(c)
    }
  },

  git_pull: {
    mutating: true,
    botScoped: true,
    summary: () => 'Pull latest from GitHub and restart',
    schema: {
      type: 'function',
      function: { name: 'git_pull', description: 'Pull the latest commit, reinstall deps if needed, and restart.', parameters: { type: 'object', properties: {} } }
    },
    run: async (_args, ctx) => {
      let log = ''
      await sup.updateBot(ctx.botId, (s) => {
        log += s
      })
      return clip(log || 'Updated.')
    }
  },

  // ---- Fleet (cross-bot, read-only) ----------------------------------------
  // These take an explicit botId argument instead of operating on ctx.dir, so
  // the Main/fleet session can inspect every managed bot at once.

  list_bots: {
    mutating: false,
    fleet: true,
    schema: {
      type: 'function',
      function: {
        name: 'list_bots',
        description: 'List every managed bot with its id, name, status, CPU%, memory (MB) and uptime.',
        parameters: { type: 'object', properties: {} }
      }
    },
    run: async () => {
      const bots = await sup.listBots()
      const rows = bots.map((b) => ({
        id: b.manifest.id,
        name: b.manifest.name,
        status: b.runtime.status,
        cpu: b.runtime.cpu,
        memMB: b.runtime.memMB,
        uptime: b.runtime.uptime,
        pid: b.runtime.pid,
        restarts: b.runtime.restarts
      }))
      return clip(JSON.stringify(rows, null, 2) || '(no bots)')
    }
  },

  get_bot_status: {
    mutating: false,
    fleet: true,
    schema: {
      type: 'function',
      function: {
        name: 'get_bot_status',
        description: 'Get the live runtime status of one bot by id (status, pid, restarts, cpu, memory, uptime, env readiness, framework).',
        parameters: { type: 'object', properties: { botId: { type: 'string' } }, required: ['botId'] }
      }
    },
    run: async (args) => {
      const id = String(args.botId ?? '').trim()
      if (!id) return 'Missing botId.'
      try {
        const b = await sup.getBot(id)
        return JSON.stringify({ id: b.manifest.id, name: b.manifest.name, ...b.runtime, framework: b.manifest.framework }, null, 2)
      } catch (e) {
        return `Error: ${(e as Error).message}`
      }
    }
  },

  read_bot_logs: {
    mutating: false,
    fleet: true,
    schema: {
      type: 'function',
      function: {
        name: 'read_bot_logs',
        description: "Read the last N lines of one bot's stdout+stderr logs, by bot id.",
        parameters: {
          type: 'object',
          properties: { botId: { type: 'string' }, n: { type: 'number' } },
          required: ['botId']
        }
      }
    },
    run: async (args) => {
      const id = String(args.botId ?? '').trim()
      if (!id) return 'Missing botId.'
      const n = Math.min(200, Math.max(1, Number(args.n) || 30))
      return clip(tailBotLogs(id, n) || '(no logs yet)')
    }
  }
}

/** Schemas the model may call, filtered by whether writes are allowed. */
export function toolSchemasFor(allowWrites: boolean): ToolSchema[] {
  return Object.values(TOOLS)
    .filter((t) => allowWrites || !t.mutating)
    .map((t) => t.schema)
}
