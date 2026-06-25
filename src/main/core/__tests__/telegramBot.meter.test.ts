import { describe, it, expect } from 'vitest'
import { aiKindFor } from '../telegramBot'

describe('control-bot AI kind mapping', () => {
  it('maps /fix (allowWrites) to fix and /ask to ask', () => {
    expect(aiKindFor(true)).toBe('fix')
    expect(aiKindFor(false)).toBe('ask')
  })
})
