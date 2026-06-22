import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnvKeys, writeEnvFile, readEnvFile, readEnvExample } from '../env'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sentinel-env-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('parseEnvKeys', () => {
  it('extracts keys, ignoring comments and blank lines', () => {
    const text = `# comment\nTELEGRAM_API_ID=123\n\nTELEGRAM_API_HASH=abc\n# BOT_TOKEN=skip-commented`
    expect(parseEnvKeys(text)).toEqual(['TELEGRAM_API_ID', 'TELEGRAM_API_HASH'])
  })
})

describe('writeEnvFile', () => {
  it('writes KEY=value lines and locks the file to 600', () => {
    const d = tmp()
    writeEnvFile(d, { A: '1', B: 'hello world' })
    const p = join(d, '.env')
    const body = readFileSync(p, 'utf8')
    expect(body).toContain('A=1')
    expect(body).toContain('B="hello world"')
    const mode = statSync(p).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('round-trips through readEnvFile', () => {
    const d = tmp()
    writeEnvFile(d, { TOKEN: 'abc123', CHAT: '-100' })
    expect(readEnvFile(d)).toEqual({ TOKEN: 'abc123', CHAT: '-100' })
  })
})

describe('readEnvExample', () => {
  it('reads .env.example placeholder values', () => {
    const d = tmp()
    writeFileSync(join(d, '.env.example'), 'API_ID=put-here\nAPI_HASH=xxxx\n')
    expect(readEnvExample(d)).toEqual({ API_ID: 'put-here', API_HASH: 'xxxx' })
  })
})
