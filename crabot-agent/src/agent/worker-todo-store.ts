export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
}

export class TodoStore {
  private items: TodoItem[] = []

  list(): ReadonlyArray<TodoItem> {
    return [...this.items]
  }

  replace(todos: ReadonlyArray<TodoItem>): void {
    this.validate(todos)
    this.items = todos.map(t => ({ ...t }))
  }

  merge(todos: ReadonlyArray<TodoItem>): void {
    const next = this.items.map(t => ({ ...t }))
    for (const incoming of todos) {
      this.validateItem(incoming)
      const idx = next.findIndex(t => t.id === incoming.id)
      if (idx >= 0) next[idx] = { ...incoming }
      else next.push({ ...incoming })
    }
    this.assertSingleInProgress(next)
    this.items = next
  }

  /**
   * 渲染 active list（pending + in_progress）为人可读字符串，
   * 用于 context compaction 后注入到 user msg。
   * 只剩 completed/cancelled 时返回 null（无注入价值）。
   */
  formatForInjection(): string | null {
    const active = this.items.filter(
      t => t.status === 'pending' || t.status === 'in_progress'
    )
    if (active.length === 0) return null
    const lines = [
      '[Your active task list was preserved across context compression]',
      ...active.map(t => {
        const glyph = t.status === 'in_progress' ? '[>]' : '[ ]'
        return `- ${glyph} ${t.id}: ${t.content} (${t.status})`
      }),
    ]
    return lines.join('\n')
  }

  // --- validation helpers ---

  private validate(todos: ReadonlyArray<TodoItem>): void {
    const seen = new Set<string>()
    for (const t of todos) {
      this.validateItem(t)
      if (seen.has(t.id)) throw new Error(`TodoStore: duplicate id "${t.id}"`)
      seen.add(t.id)
    }
    this.assertSingleInProgress(todos)
  }

  private validateItem(t: TodoItem): void {
    if (!t.id || typeof t.id !== 'string') {
      throw new Error('TodoStore: id must be non-empty string')
    }
    if (!t.content || typeof t.content !== 'string') {
      throw new Error('TodoStore: content must be non-empty string')
    }
    if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(t.status)) {
      throw new Error(`TodoStore: invalid status "${t.status}"`)
    }
  }

  private assertSingleInProgress(todos: ReadonlyArray<TodoItem>): void {
    const count = todos.filter(t => t.status === 'in_progress').length
    if (count > 1) {
      throw new Error('TodoStore: Only one item can be in_progress at a time')
    }
  }
}
