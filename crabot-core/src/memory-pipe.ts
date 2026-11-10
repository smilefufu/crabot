import type { ChildProcess } from 'node:child_process'
import { RuntimeStreamChannel } from './runtime-stream.js'

/** Memory reserves stdout for frames and keeps diagnostics on stderr. */
export class MemoryPipeChannel extends RuntimeStreamChannel {
  constructor(child: ChildProcess) {
    if (!child.stdin || !child.stdout) throw new Error('Memory requires managed stdin/stdout pipes')
    super(child.stdout, child.stdin)
    child.on('exit', () => this.close())
    child.on('error', () => this.close())
  }
}
