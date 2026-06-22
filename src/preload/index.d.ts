import type { SentinelAPI } from '@shared/ipc'

declare global {
  interface Window {
    sentinel: SentinelAPI
  }
}

export {}
