import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { encode, decode } from '@msgpack/msgpack'

/** Memory stdout is a binary protocol; diagnostics stay on stderr. */
export class MemoryPipeChannel extends EventEmitter {
  connected = true
  private buffered = Buffer.alloc(0)

  constructor(private readonly child: ChildProcess) {
    super()
    if (!child.stdin || !child.stdout) throw new Error('Memory requires managed stdin/stdout pipes')
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    child.stdout.on('end', () => this.disconnect())
    child.stdout.on('error', () => this.disconnect())
    child.stdin.on('error', () => this.disconnect())
    child.on('exit', () => this.disconnect())
    child.on('error', () => this.disconnect())
  }

  send(message: object, callback: (error: Error | null) => void): boolean {
    if (!this.connected) { callback(new Error('Memory channel disconnected')); return false }
    const encoded = encode(message, { ignoreUndefined: true })
    const packet = Buffer.allocUnsafe(4 + encoded.byteLength)
    packet.writeUInt32BE(encoded.byteLength)
    packet.set(encoded, 4)
    return this.child.stdin!.write(packet, error => callback(error ?? null))
  }

  private receive(chunk: Buffer): void {
    if (!this.connected) return
    this.buffered = Buffer.concat([this.buffered, chunk])
    try {
      while (this.buffered.length >= 4) {
        const size = this.buffered.readUInt32BE(0)
        if (this.buffered.length < size + 4) return
        const message = decode(this.buffered.subarray(4, size + 4))
        this.buffered = this.buffered.subarray(size + 4)
        this.emit('message', message)
      }
    } catch { this.disconnect() }
  }

  private disconnect(): void {
    if (!this.connected) return
    this.connected = false
    this.buffered = Buffer.alloc(0)
    this.emit('disconnect')
  }
}
