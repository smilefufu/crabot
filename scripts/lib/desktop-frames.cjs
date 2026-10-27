const { TextDecoder } = require('node:util')

// One frame per handshake step. A persistent listener retains early data between awaits.
class DesktopFrames {
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.queued = undefined; this.waiting = undefined; this.failure = undefined
    this.data = bytes => {
      try {
        if (this.buffer.length + bytes.length > 65536) throw new Error('Desktop frame exceeds 64 KiB')
        this.buffer = Buffer.concat([this.buffer, bytes])
        if (this.buffer.length > 65536) throw new Error('Desktop frame exceeds 64 KiB')
        const newline = this.buffer.indexOf(10)
        if (newline < 0) return
        if (newline !== this.buffer.length - 1 || this.queued !== undefined) throw new Error('Unexpected desktop frames')
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, newline)))
        this.buffer = Buffer.alloc(0)
        if (this.waiting) { const pending = this.waiting; this.waiting = undefined; pending.resolve(value) }
        else this.queued = { value }
      } catch { this.fail(new Error('Invalid desktop frame')) }
    }
    this.error = () => this.fail(new Error('Desktop connection unavailable'))
    socket.on('data', this.data); socket.on('error', this.error); socket.on('close', this.error)
  }
  fail(error) {
    this.failure ??= error
    this.waiting?.reject(this.failure); this.waiting = undefined
    this.socket.destroy()
  }
  read() {
    if (this.failure) return Promise.reject(this.failure)
    if (this.waiting) return Promise.reject(new Error('Desktop frame read already pending'))
    if (this.queued) { const value = this.queued.value; this.queued = undefined; return Promise.resolve(value) }
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject } })
  }
  write(value) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n')
    if (bytes.length > 65536) throw new Error('Desktop frame exceeds 64 KiB')
    if (this.failure || this.socket.destroyed) throw new Error('Desktop connection unavailable')
    this.socket.write(bytes)
  }
  close() {
    this.socket.off('data', this.data); this.socket.off('error', this.error); this.socket.off('close', this.error)
    this.fail(new Error('Desktop handshake ended'))
  }
}

module.exports = { DesktopFrames }
