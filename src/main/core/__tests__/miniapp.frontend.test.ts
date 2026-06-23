import { describe, it, expect } from 'vitest'
import { MINIAPP_HTML } from '../miniapp/frontend/index'

describe('miniapp html', () => {
  it('is a single self-contained document', () => {
    expect(MINIAPP_HTML.startsWith('<!doctype html>')).toBe(true)
    expect(MINIAPP_HTML).toContain('telegram-web-app.js')
  })
  it('exposes the view registry + api helper + tab bar', () => {
    expect(MINIAPP_HTML).toContain('registerView')
    expect(MINIAPP_HTML).toContain('X-Tg-Init-Data')
    expect(MINIAPP_HTML).toContain('id="tabbar"')
  })
  it('contains the glass design tokens + animation keyframes', () => {
    expect(MINIAPP_HTML).toContain('--glass')
    expect(MINIAPP_HTML).toContain('@keyframes')
  })
})
