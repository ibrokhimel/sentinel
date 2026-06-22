/**
 * Process statistics via `ps` (absolute path so it works under launchd's
 * minimal PATH). Memory (RSS) is instantaneous and reliable; CPU from `ps %cpu`
 * is a lifetime average (≈0 for an idle bot), so for a meaningful "how much is
 * it eating right now" we can sample CPU time twice and take the delta.
 */
import { cpus, totalmem } from 'node:os'
import { exec } from './exec'

const PS = '/bin/ps'

export interface ProcStat {
  /** Percent of ONE core. Instantaneous when sampled, else lifetime average. */
  cpu: number | null
  memMB: number | null
  /** RSS as a percent of total system RAM. */
  memPct: number | null
  /** Elapsed wall-clock uptime, e.g. "02:59" or "1-03:04:05". */
  uptime: string | null
}

const EMPTY: ProcStat = { cpu: null, memMB: null, memPct: null, uptime: null }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function num(s?: string): number | null {
  const n = s != null ? parseFloat(s) : NaN
  return Number.isFinite(n) ? n : null
}

/** Parse ps cputime "[dd-]hh:mm:ss[.ss]" / "mm:ss.ss" into seconds. */
export function cputimeToSec(t: string): number | null {
  if (!t) return null
  let days = 0
  let rest = t
  if (t.includes('-')) {
    const [d, r] = t.split('-')
    days = parseInt(d, 10) || 0
    rest = r
  }
  const parts = rest.split(':').map(Number)
  if (parts.some((p) => Number.isNaN(p))) return null
  let sec = 0
  for (const p of parts) sec = sec * 60 + p
  return sec + days * 86400
}

async function cputimeSec(pid: number): Promise<number | null> {
  try {
    const r = await exec(PS, ['-o', 'time=', '-p', String(pid)])
    return cputimeToSec(r.stdout.trim())
  } catch {
    return null
  }
}

/**
 * Read a process's stats. `sampleMs > 0` measures instantaneous CPU by diffing
 * CPU time over that window (adds latency); otherwise CPU is the lifetime avg.
 */
export async function procStat(pid: number, sampleMs = 0): Promise<ProcStat> {
  try {
    const r = await exec(PS, ['-o', '%cpu=,rss=,etime=', '-p', String(pid)])
    const line = r.stdout.trim()
    if (!line) return { ...EMPTY }
    const p = line.split(/\s+/)
    let cpu = num(p[0])
    const rssKb = num(p[1])
    const uptime = p[2] ?? null
    const memMB = rssKb != null ? Math.round(rssKb / 1024) : null
    const totalMB = totalmem() / (1024 * 1024)
    const memPct = memMB != null ? +((memMB / totalMB) * 100).toFixed(1) : null

    if (sampleMs > 0) {
      const t1 = await cputimeSec(pid)
      if (t1 != null) {
        await sleep(sampleMs)
        const t2 = await cputimeSec(pid)
        if (t2 != null) cpu = +(((t2 - t1) / (sampleMs / 1000)) * 100).toFixed(1)
      }
    }
    return { cpu, memMB, memPct, uptime }
  } catch {
    return { ...EMPTY }
  }
}

export function systemBrief(): { cores: number; totalGB: number } {
  return { cores: cpus().length, totalGB: +(totalmem() / 1024 ** 3).toFixed(1) }
}
