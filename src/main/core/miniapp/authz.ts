/**
 * authz.ts — the single authorization chokepoint for bot-scoped access.
 * Pure decision logic (`can`) plus registry-backed helpers. Default-deny.
 */
import { readRegistry, findEntry, type RegistryEntry, type Capabilities } from '../registry'

export type Capability =
  | 'view' | 'viewLogs' | 'chat' | 'startStop' | 'deploy' | 'editEnv' | 'viewSecrets'

export class ForbiddenError extends Error {
  constructor(msg = 'forbidden') {
    super(msg)
    this.name = 'ForbiddenError'
  }
}

/** Pure: may `uid` perform `cap` on `entry`? Host and owner → all; collaborator → toggle. */
export function can(
  uid: number,
  isHost: boolean,
  entry: RegistryEntry | undefined,
  cap: Capability
): boolean {
  if (isHost) return true
  if (!entry) return false
  if (entry.ownerId === uid) return true
  const caps: Capabilities | undefined = entry.collaborators?.[String(uid)]
  if (!caps) return false
  if (cap === 'view') return true
  return caps[cap] === true
}

/** All registry entries the caller may at least see. */
export function botsVisibleTo(uid: number, isHost: boolean): RegistryEntry[] {
  return readRegistry().filter((e) => can(uid, isHost, e, 'view'))
}

/** Throw ForbiddenError unless allowed; return the entry when allowed. */
export function assertCap(uid: number, isHost: boolean, botId: string, cap: Capability): RegistryEntry {
  const entry = findEntry(botId)
  if (!can(uid, isHost, entry, cap)) throw new ForbiddenError()
  return entry as RegistryEntry
}
