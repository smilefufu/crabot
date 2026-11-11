import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { encode, decode } from '@msgpack/msgpack'

/** A private byte stream carries framed runtime calls; it never logs frame bodies. */
export class RuntimeStreamChannel extends EventEmitter {
  connected = true
  private buffered = Buffer.alloc(0)

  constructor(readable: Readable, private readonly writable: Writable) {
    super()
    readable.on('data', (chunk: Buffer) => this.receive(chunk))
    readable.on('end', () => this.close())
    readable.on('close', () => this.close())
    readable.on('error', () => this.close())
    writable.on('error', () => this.close())
  }

  send(message: object, callback: (error: Error | null) => void): boolean {
    if (!this.connected) { callback(new Error('Runtime channel disconnected')); return false }
    const encoded = encode(message, { ignoreUndefined: true })
    const packet = Buffer.allocUnsafe(4 + encoded.byteLength)
    packet.writeUInt32BE(encoded.byteLength)
    packet.set(encoded, 4)
    return this.writable.write(packet, error => callback(error ?? null))
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
    } catch { this.close() }
  }

  close(): void {
    if (!this.connected) return
    this.connected = false
    this.buffered = Buffer.alloc(0)
    this.emit('disconnect')
  }
}
