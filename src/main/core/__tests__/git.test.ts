import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkForUpdates, currentSha, changedFiles, resetHard, isGitRepo, nameFromUrl } from '../git'

const dirs: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=Test', ...args], {
    cwd,
    encoding: 'utf8'
  }).trim()
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('git update primitives', () => {
  it('detects commits behind, changed files, current sha, and rolls back', () => {
    // upstream repo with one commit on main
    const upstream = tmp('sentinel-git-up-')
    git(upstream, 'init', '-b', 'main')
    writeFileSync(join(upstream, 'requirements.txt'), 'telethon\n')
    writeFileSync(join(upstream, 'main.py'), 'print(1)\n')
    git(upstream, 'add', '-A')
    git(upstream, 'commit', '-m', 'c1')

    // clone it
    const work = tmp('sentinel-git-work-')
    execFileSync('git', ['clone', upstream, work], { encoding: 'utf8' })
    expect(isGitRepo(work)).toBe(true)

    return (async () => {
      const sha1 = await currentSha(work)
      expect(sha1).toMatch(/^[0-9a-f]{40}$/)

      // No new upstream commits yet → 0 behind.
      let chk = await checkForUpdates(work)
      expect(chk.isGit).toBe(true)
      expect(chk.behind).toBe(0)

      // Add an upstream commit that changes a dependency file.
      writeFileSync(join(upstream, 'requirements.txt'), 'telethon\naiohttp\n')
      git(upstream, 'add', '-A')
      git(upstream, 'commit', '-m', 'c2 add dep')

      chk = await checkForUpdates(work)
      expect(chk.behind).toBe(1)
      expect(chk.branch).toBe('main')

      // Pull and confirm the dependency file shows up in the diff.
      git(work, 'pull', '--ff-only', 'origin', 'main')
      const sha2 = await currentSha(work)
      expect(sha2).not.toBe(sha1)
      const changed = await changedFiles(work, sha1!, sha2!)
      expect(changed).toContain('requirements.txt')

      // Roll back to the first commit.
      await resetHard(work, sha1!)
      expect(await currentSha(work)).toBe(sha1)
    })()
  })

  it('derives a name from a URL', () => {
    expect(nameFromUrl('https://github.com/owner/MyBot.git')).toBe('MyBot')
    expect(nameFromUrl('https://github.com/owner/repo')).toBe('repo')
  })
})
