import type { ContentBlock } from './types'

export type QueueContent = string | ContentBlock[]
export type QueueTransform = (content: QueueContent) => QueueContent

export class HumanMessageQueue {
  private pending: QueueContent[] = []
  private waitResolve: ((value: QueueContent) => void) | null = null
  private children: Set<{ queue: HumanMessageQueue; transform?: QueueTransform }> = new Set()

  push(content: QueueContent): void {
    if (this.waitResolve) {
      const resolve = this.waitResolve
      this.waitResolve = null
      resolve(content)
    } else {
      this.pending = [...this.pending, content]
    }
    for (const child of this.children) {
      const transformed = child.transform ? child.transform(content) : content
      child.queue.push(transformed)
    }
  }

  async dequeue(): Promise<QueueContent> {
    if (this.pending.length > 0) {
      const [first, ...rest] = this.pending
      this.pending = rest
      return first
    }
    return new Promise<QueueContent>((resolve) => {
      this.waitResolve = resolve
    })
  }

  drainPending(): QueueContent[] {
    const drained = this.pending
    this.pending = []
    return drained
  }

  get hasPending(): boolean {
    return this.pending.length > 0
  }

  createChild(transform?: QueueTransform): HumanMessageQueue {
    const child = new HumanMessageQueue()
    const entry = { queue: child, transform }
    this.children = new Set([...this.children, entry])
    return child
  }

  removeChild(child: HumanMessageQueue): void {
    const next = new Set<{ queue: HumanMessageQueue; transform?: QueueTransform }>()
    for (const entry of this.children) {
      if (entry.queue !== child) {
        next.add(entry)
      }
    }
    this.children = next
  }
}
