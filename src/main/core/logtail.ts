import { existsSync, statSync, createReadStream, watch, type FSWatcher } from 'node:fs'

type LineCb = (chunk: string) => void

/**
 * Tail a log file: emit the last `tailBytes` immediately, then stream appended
 * data as the file grows. Handles truncation/rotation by resetting the offset.
 */
export class LogTail {
  private watcher: FSWatcher | null = null
  private offset = 0
  private reading = false

  constructor(
    private path: string,
    private onData: LineCb,
    private tailBytes = 64 * 1024
  ) {}

  start(): void {
    if (existsSync(this.path)) {
      const size = statSync(this.path).size
      this.offset = Math.max(0, size - this.tailBytes)
      this.readAppended()
    }
    try {
      this.watcher = watch(this.path, () => this.readAppended())
    } catch {
      // File may not exist yet; poll until it does, then watch.
      const poll = setInterval(() => {
        if (existsSync(this.path)) {
          clearInterval(poll)
          this.start()
        }
      }, 1000)
    }
  }

  private readAppended(): void {
    if (this.reading || !existsSync(this.path)) return
    const size = statSync(this.path).size
    if (size < this.offset) this.offset = 0 // rotated/truncated
    if (size === this.offset) return
    this.reading = true
    const stream = createReadStream(this.path, { start: this.offset, end: size - 1 })
    let buf = ''
    stream.on('data', (d) => (buf += d.toString()))
    stream.on('end', () => {
      this.offset = size
      this.reading = false
      if (buf) this.onData(buf)
    })
    stream.on('error', () => {
      this.reading = false
    })
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
  }
}
