import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseDotenv } from 'dotenv'

/** Extract the variable names from a .env / .env.example file body. */
export function parseEnvKeys(text: string): string[] {
  return Object.keys(parseDotenv(text))
}

/** Parse a .env file into { KEY: value }. */
export function parseEnvValues(text: string): Record<string, string> {
  return parseDotenv(text)
}

/** Read the example values (used as placeholder hints in the form). */
export function readEnvExample(dir: string): Record<string, string> {
  for (const name of ['.env.example', '.env.sample']) {
    const p = join(dir, name)
    if (existsSync(p)) return parseDotenv(readFileSync(p, 'utf8'))
  }
  return {}
}

/** Read the current real .env values, if present. */
export function readEnvFile(dir: string, envFile = '.env'): Record<string, string> {
  const p = join(dir, envFile)
  if (existsSync(p)) return parseDotenv(readFileSync(p, 'utf8'))
  return {}
}

/**
 * Serialize values to a .env file and lock it down to owner-only (chmod 600).
 * Values containing whitespace or special characters are double-quoted.
 */
export function writeEnvFile(
  dir: string,
  values: Record<string, string>,
  envFile = '.env'
): void {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${serializeValue(v)}`)
  const p = join(dir, envFile)
  writeFileSync(p, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch {
    /* best effort */
  }
}

function serializeValue(v: string): string {
  if (v === '') return ''
  if (/[\s#"'$`\\]/.test(v)) {
    return `"${v.replace(/(["\\$`])/g, '\\$1')}"`
  }
  return v
}
