# Plugins & Tools Installed — Session of 2026-06-19

This document covers everything installed during this Claude Code session: 5 plugins
plus 2 standalone CLI tool-suites. For each item: **what it does**, **how it works**,
and **its commands / skills**.

> Source of truth: read directly from the installed plugin manifests, READMEs, and
> skill/command directories under `~/.claude/plugins/`.

---

## Quick Index

| # | Name | Type | Source | Version |
|---|------|------|--------|---------|
| 1 | `skill-creator` | Plugin (skill) | `claude-plugins-official` (Anthropic) | — |
| 2 | `superpowers` | Plugin (skills library) | `claude-plugins-official` (Jesse Vincent / obra) | 6.0.3 |
| 3 | `context-mode` | Plugin (MCP server + skills) | `mksglu/context-mode` | 1.0.162 |
| 4 | `claude-mem` | Plugin (memory system + skills) | `thedotmack/claude-mem` | 13.6.2 |
| 5 | `frontend-design` | Plugin (skill) | `claude-plugins-official` (Anthropic) | — |
| 6 | Get Shit Done (GSD) | CLI tool-suite (npx) | `get-shit-done-cc` | 1.42.3 |
| 7 | Ruflo v3 | CLI + MCP server | `ruvnet/ruflo` (install.sh) | 3.12.4 |

> Note: `ruflo-core@ruflo` was re-run this session but reported *"already installed
> globally"* — it was installed in a prior session, so it is not re-documented here.

---

## 1. skill-creator

**What it does**
Anthropic's official toolkit for authoring, improving, and benchmarking *Claude Skills*.
Use it to create a skill from scratch, optimize an existing one, run evals against it,
and measure performance with variance analysis.

**How it works**
It ships as a single skill (`skill-creator`) backed by helper agents and Python scripts.
The skill walks you through writing the `SKILL.md` (YAML frontmatter + progressive-disclosure
body), then can package and validate the result. The eval pipeline runs your skill against
test cases, grades the output with a grader agent, and aggregates a benchmark report with an
HTML viewer.

- **Sub-agents:** `analyzer`, `comparator`, `grader` (used during eval/optimize)
- **Scripts:** `run_eval.py`, `run_loop.py`, `aggregate_benchmark.py`, `generate_report.py`,
  `improve_description.py`, `package_skill.py`, `quick_validate.py`
- **Eval viewer:** `eval-viewer/viewer.html` renders graded results

**Commands / how to invoke**
No slash commands — it's a model-invoked skill. Trigger it conversationally:
- *"Create a skill that …"* / *"Improve my X skill"* / *"Run evals on this skill"*
- Or explicitly: `/skill-creator`

---

## 2. superpowers

**What it does**
A complete, opinionated software-development *methodology* delivered as a library of
composable skills: TDD, systematic debugging, planning, code review, and collaboration
patterns. The skills trigger automatically as you work — the agent stops to spec out the
problem before coding, writes a plan, then executes it via subagents.

**How it works**
It's a pure-skills plugin (no MCP server). Each skill is a self-contained workflow that the
model loads when the situation matches. The flagship loop is: *brainstorm spec → write plan →
subagent-driven execution → review → finish branch*, with red/green TDD, YAGNI, and DRY
enforced throughout. A bundled hook nudges the agent to consult the skills at the right moments.

**Skills (14)**
| Skill | Purpose |
|-------|---------|
| `brainstorming` | Tease a spec out of a vague request before any code |
| `writing-plans` | Produce a clear implementation plan |
| `executing-plans` | Work through a plan step by step |
| `subagent-driven-development` | Delegate plan tasks to subagents with review gates |
| `test-driven-development` | True red/green TDD discipline |
| `systematic-debugging` | Scientific-method bug hunting |
| `verification-before-completion` | Prove the change works before declaring done |
| `requesting-code-review` | Ask for a structured review |
| `receiving-code-review` | Apply review feedback methodically |
| `dispatching-parallel-agents` | Fan out independent work across agents |
| `using-git-worktrees` | Isolate work in worktrees |
| `finishing-a-development-branch` | Clean branch wrap-up / merge prep |
| `writing-skills` | Author new skills (Superpowers conventions) |
| `using-superpowers` | Meta-skill: how to use the whole system |

**Commands / how to invoke**
No slash commands — skills auto-trigger. You can also call them explicitly, e.g.
`/superpowers:brainstorming`, `/superpowers:test-driven-development`,
`/superpowers:systematic-debugging`.

---

## 3. context-mode

**What it does**
An MCP server that **saves ~98% of your context window** and adds session continuity.
It keeps raw tool output (Playwright snapshots, logs, big file reads) *out* of the context
window by executing code in a sandbox and returning only the result. It also persists every
file edit, git op, task, error, and decision to SQLite so the agent survives compaction.

**How it works**
Four mechanisms:
1. **Context saving** — sandbox tools run code and return only `console.log` output (e.g.
   315 KB → 5.4 KB).
2. **Session continuity** — events go to SQLite, indexed into FTS5; on compaction the model
   retrieves only relevant events via BM25 search instead of re-dumping everything. (Without
   `--continue`, prior session data is wiped — fresh session = clean slate.)
3. **"Think in code"** — the LLM writes a script to do analysis rather than reading 50 files
   into context.
4. **No prose-style enforcement** — it controls *where data goes*, not how the model writes.

Runs via `node ${CLAUDE_PLUGIN_ROOT}/start.mjs` as a stdio MCP server. Sandboxed execution
supports 11 languages; knowledge base uses FTS5 + BM25.

**MCP tools**
`ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, `ctx_search`, `ctx_search_v`,
`ctx_index`, `ctx_fetch_and_index`, `ctx_insight`, `ctx_stats`, `ctx_doctor`,
`ctx_purge`, `ctx_upgrade`

**Skills / slash commands**
`context-mode` (main), `ctx-search`, `ctx-index`, `ctx-insight`, `ctx-stats`,
`ctx-doctor`, `ctx-purge`, `ctx-upgrade` — wrappers around the matching MCP tools for
searching, indexing, inspecting, health-checking, purging, and upgrading the context store.

---

## 4. claude-mem

**What it does**
A persistent **memory-compression system** for Claude Code. It captures observations from your
sessions into a knowledge graph and re-injects relevant memory into future sessions, so context
persists across conversations ("did we already solve this?").

**How it works**
Hooks watch the session transcript and compress observations into a store; on a new session,
relevant memory is injected back. A large set of skills sits on top of the memory store for
search, planning, codebase priming, reporting, and release workflows. Ships with hooks
(`plugin/hooks/hooks.json`), modes, and a UI.

**Skills (16)**
| Skill | Purpose |
|-------|---------|
| `mem-search` | Search the cross-session memory database |
| `how-it-works` | Explain capture/injection and where data lives |
| `knowledge-agent` | Build/query AI knowledge bases from observations |
| `learn-codebase` | Prime a project by reading every source file |
| `smart-explore` | Token-optimized tree-sitter AST code search |
| `pathfinder` | Map codebase into feature flowcharts, find dupes |
| `make-plan` | Phased implementation plan with doc discovery |
| `do` | Execute a phased plan via subagents |
| `babysit` | Watch a PR / review cycle until merge-ready |
| `standup` | Read-only standup across worktrees/branches/PRs |
| `oh-my-issues` | Cluster a GitHub issue backlog by root cause |
| `design-is` | Audit a design against Dieter Rams' 10 principles |
| `timeline-report` | "Journey Into [Project]" narrative from history |
| `weekly-digests` | Week-by-week narrative digest of project timeline |
| `version-bump` | Semantic versioning + release workflow for plugins |
| `wowerpoint` | Turn a document into a kawaii slide-deck PDF |

**Commands**
Slash command `anti-pattern-czar`; CLI (`npx claude-mem …`) subcommands: `install`,
`uninstall`, `doctor`, `server`, plus runtime/telemetry internals.

---

## 5. frontend-design

**What it does**
Anthropic's official skill for **UI/UX implementation** — building and polishing front-end
interfaces to a production-quality bar.

**How it works**
A single model-invoked skill (`frontend-design`) providing design guidance (layout, type,
color, spacing, interaction, accessibility) and clean component implementation patterns. No
MCP server, no slash commands.

**Commands / how to invoke**
Conversational — *"design/build/polish this UI"* — or explicitly `/frontend-design`.

---

## 6. Get Shit Done (GSD) — *not a plugin; CLI tool-suite*

Installed via `npx get-shit-done-cc --claude --global` (v1.42.3) into `~/.claude`.
> ⚠️ The npm package is marked deprecated/"no longer supported", but the install succeeded.

**What it does**
A meta-prompting, context-engineering, and **spec-driven development system**. It installs a
large workflow framework: 67 skills, a fleet of `gsd-*` agents, and several hooks, all aimed at
taking a project from idea → roadmap → phase plans → execution → review.

**How it works**
It writes skills/agents/hooks directly into `~/.claude` (not as a marketplace plugin). The
`gsd-*` agents (e.g. `gsd-roadmapper`, `gsd-planner`, `gsd-executor`, `gsd-verifier`,
`gsd-code-reviewer`, `gsd-debugger`, `gsd-ui-researcher`) are orchestrated by `/gsd:*`
commands. Hooks installed include: update check, context-window monitor, prompt-injection
guard, read-before-edit guard, read injection scanner, plus opt-in workflow/commit/phase hooks.
A `gsd-sdk` binary is linked to `~/.local/bin/gsd-sdk`.

**Commands / how to start**
Restart Claude Code, then run `/gsd-new-project` (or ask for the `gsd-new-project` skill).
Other entry points: `/gsd:plan-phase`, `/gsd:execute-phase`, `/gsd:code-review`,
`/gsd:debug`, `/gsd:ui-phase`, `/gsd:verify`, etc.

---

## 7. Ruflo v3 — *not a plugin; CLI + MCP server*

Installed via `curl … ruflo/scripts/install.sh | bash` (v3.12.4), then registered as an
MCP server with `claude mcp add ruflo -- npx ruflo@latest mcp start`.

**What it does**
An AI-agent **orchestration framework**: multi-agent swarms, hybrid vector memory (AgentDB /
RuVector with HNSW + ONNX embeddings), hooks-based routing, and a large MCP tool surface for
coordination, memory, security (AIDefence), and intelligence/learning.

**How it works**
`init` scaffolds a project (`.claude-flow/` runtime: config, data, logs, sessions) and writes
Claude Code integration (CLAUDE.md guidance, `.claude/settings.json` hooks, ~30 skills, ~16
commands, ~17 agents, `.mcp.json`). The MCP server (`npx ruflo@latest mcp start`) exposes the
coordination/memory/swarm/hooks tools. An optional background `daemon` runs interval workers
(consumes tokens continuously — start only if wanted).

**Commands (CLI / MCP)**
- CLI: `ruflo init --wizard`, `ruflo doctor [--fix]`, `ruflo swarm init`, `ruflo memory init`,
  `ruflo daemon start`, `ruflo metaharness score`, `ruflo security scan`,
  `ruflo performance benchmark` (26 commands, 140+ subcommands; `--help` on any).
- MCP tools (via `ToolSearch`): `swarm_init`, `agent_spawn`, `memory_store`, `memory_search`,
  `hooks_route`, `aidefence_scan`, `hive-mind_*`, and many more.

---

## Activation reminder

Plugins (#1–#5) require **`/reload-plugins`** (or a Claude Code restart) to take effect.
GSD and Ruflo wrote into `~/.claude` and likewise need a **restart** to load their hooks,
skills, and agents.
