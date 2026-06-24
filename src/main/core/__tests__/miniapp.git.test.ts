import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

// Must be hoisted before any imports of the module under test
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

// Mock supervisor so git.ts can be imported
vi.mock('../../supervisor', () => ({
  updateBot: vi.fn(),
  pushLive: vi.fn(),
}))

import { spawn } from 'node:child_process'
import { ROUTES } from '../miniapp/routes/index'
import { gitRoutes } from '../miniapp/routes/git'

// Helper: build a fake child-process EventEmitter with stdout/stderr streams
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

// Helper: build a fake RouteCtx
function makeCtx() {
  const responses: Array<[number, unknown]> = []
  return {
    body: {},
    json(status: number, body: unknown) { responses.push([status, body]) },
    responses,
  }
}

function getApplyHandler() {
  const route = gitRoutes.find((r) => r.path === '/api/git/apply')
  if (!route) throw new Error('apply route not found')
  return route.handler as unknown as (c: ReturnType<typeof makeCtx>) => void
}

describe('git route table', () => {
  it('has POST /api/git/update and it is ownerOnly', () => {
    const r = ROUTES.find((r) => r.method === 'POST' && r.path === '/api/git/update')
    expect(r).toBeDefined()
    expect(r?.ownerOnly).toBe(true)
  })
  it('has POST /api/git/push and it is ownerOnly', () => {
    const r = ROUTES.find((r) => r.method === 'POST' && r.path === '/api/git/push')
    expect(r).toBeDefined()
    expect(r?.ownerOnly).toBe(true)
  })
  it('has POST /api/git/apply and it is ownerOnly', () => {
    const r = ROUTES.find((r) => r.method === 'POST' && r.path === '/api/git/apply')
    expect(r).toBeDefined()
    expect(r?.ownerOnly).toBe(true)
  })
})

describe('/api/git/apply handler — spawn error resilience', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset()
  })

  it('responds 500 once when the child emits an error event', () => {
    const child = makeFakeChild()
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)

    const ctx = makeCtx()
    getApplyHandler()(ctx)

    // error event fires — should respond 500
    child.emit('error', new Error('ENOENT'))
    expect(ctx.responses).toHaveLength(1)
    expect(ctx.responses[0][0]).toBe(500)
    expect((ctx.responses[0][1] as Record<string, string>).error).toMatch(/ENOENT/)

    // exit after error — latch must block second response
    child.emit('exit', 1)
    expect(ctx.responses).toHaveLength(1)
  })

  it('does not double-respond when exit fires first, then error arrives', () => {
    const child = makeFakeChild()
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)

    const ctx = makeCtx()
    getApplyHandler()(ctx)

    // successful exit first
    child.emit('exit', 0)
    expect(ctx.responses).toHaveLength(1)
    expect(ctx.responses[0][0]).toBe(200)

    // late error — latch must block
    child.emit('error', new Error('late error'))
    expect(ctx.responses).toHaveLength(1)
  })

  it('responds 500 with build-failed tail on non-zero exit', () => {
    const child = makeFakeChild()
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)

    const ctx = makeCtx()
    getApplyHandler()(ctx)

    child.stdout.emit('data', Buffer.from('some build output'))
    child.emit('exit', 1)

    expect(ctx.responses).toHaveLength(1)
    expect(ctx.responses[0][0]).toBe(500)
    expect((ctx.responses[0][1] as Record<string, string>).error).toBe('build failed')
  })

  it('responds 200 on exit code 0', () => {
    const child = makeFakeChild()
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)

    const ctx = makeCtx()
    getApplyHandler()(ctx)

    child.emit('exit', 0)

    expect(ctx.responses).toHaveLength(1)
    expect(ctx.responses[0][0]).toBe(200)
    expect((ctx.responses[0][1] as Record<string, boolean>).ok).toBe(true)
  })

  it('responds 500 when spawn throws synchronously', () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error('EMFILE') })

    const ctx = makeCtx()
    getApplyHandler()(ctx)

    expect(ctx.responses).toHaveLength(1)
    expect(ctx.responses[0][0]).toBe(500)
    expect((ctx.responses[0][1] as Record<string, string>).error).toMatch(/EMFILE/)
  })
})
