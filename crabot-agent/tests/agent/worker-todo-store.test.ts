import { describe, it, expect } from 'vitest'
import { TodoStore } from '../../src/agent/worker-todo-store.js'

describe('TodoStore', () => {
  it('starts empty', () => {
    const store = new TodoStore()
    expect(store.list()).toEqual([])
  })

  it('replace mode overwrites entire list', () => {
    const store = new TodoStore()
    store.replace([
      { id: 'a', content: 'first', status: 'pending' },
      { id: 'b', content: 'second', status: 'pending' },
    ])
    store.replace([{ id: 'c', content: 'third', status: 'pending' }])
    expect(store.list()).toEqual([
      { id: 'c', content: 'third', status: 'pending' },
    ])
  })

  it('merge mode updates by id and appends new ids', () => {
    const store = new TodoStore()
    store.replace([
      { id: 'a', content: 'first', status: 'pending' },
      { id: 'b', content: 'second', status: 'pending' },
    ])
    store.merge([
      { id: 'a', content: 'first', status: 'completed' },
      { id: 'c', content: 'third', status: 'pending' },
    ])
    expect(store.list()).toEqual([
      { id: 'a', content: 'first', status: 'completed' },
      { id: 'b', content: 'second', status: 'pending' },
      { id: 'c', content: 'third', status: 'pending' },
    ])
  })

  it('rejects writes with two in_progress items', () => {
    const store = new TodoStore()
    expect(() => store.replace([
      { id: 'a', content: 'A', status: 'in_progress' },
      { id: 'b', content: 'B', status: 'in_progress' },
    ])).toThrow(/Only one item can be in_progress/)
  })

  it('rejects writes with duplicate ids', () => {
    const store = new TodoStore()
    expect(() => store.replace([
      { id: 'a', content: 'A', status: 'pending' },
      { id: 'a', content: 'A2', status: 'pending' },
    ])).toThrow(/duplicate id/)
  })

  it('rejects empty id', () => {
    const store = new TodoStore()
    expect(() => store.replace([
      { id: '', content: 'A', status: 'pending' },
    ])).toThrow(/id must be non-empty/)
  })

  it('formatForInjection returns null when list empty', () => {
    expect(new TodoStore().formatForInjection()).toBeNull()
  })

  it('formatForInjection returns null when only completed/cancelled', () => {
    const store = new TodoStore()
    store.replace([
      { id: 'a', content: 'done', status: 'completed' },
      { id: 'b', content: 'gone', status: 'cancelled' },
    ])
    expect(store.formatForInjection()).toBeNull()
  })

  it('formatForInjection includes only pending + in_progress, with status glyphs', () => {
    const store = new TodoStore()
    store.replace([
      { id: 'a', content: 'fetch data', status: 'pending' },
      { id: 'b', content: 'validate', status: 'in_progress' },
      { id: 'c', content: 'old done', status: 'completed' },
    ])
    const text = store.formatForInjection()
    expect(text).toContain('[Your active task list was preserved')
    expect(text).toContain('[ ] a: fetch data (pending)')
    expect(text).toContain('[>] b: validate (in_progress)')
    expect(text).not.toContain('old done')
  })
})
