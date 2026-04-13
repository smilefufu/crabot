import { describe, it, expect } from 'vitest'
import { TraceStore } from '../../src/core/trace-store'

describe('TraceStore', () => {
  describe('startTrace with related_task_id', () => {
    it('accepts related_task_id in params', () => {
      const store = new TraceStore(10)
      const trace = store.startTrace({
        module_id: 'agent-1',
        trigger: { type: 'task', summary: 'execute task' },
        related_task_id: 'task-456',
      })
      expect(trace.related_task_id).toBe('task-456')
    })

    it('defaults related_task_id to undefined', () => {
      const store = new TraceStore(10)
      const trace = store.startTrace({
        module_id: 'agent-1',
        trigger: { type: 'message', summary: 'msg' },
      })
      expect(trace.related_task_id).toBeUndefined()
    })
  })

  describe('updateTrace', () => {
    it('updates related_task_id on an existing trace', () => {
      const store = new TraceStore(10)
      const trace = store.startTrace({
        module_id: 'agent-1',
        trigger: { type: 'message', summary: 'test msg' },
      })
      expect(trace.related_task_id).toBeUndefined()

      store.updateTrace(trace.trace_id, { related_task_id: 'task-123' })

      const updated = store.getTrace(trace.trace_id)
      expect(updated?.related_task_id).toBe('task-123')
    })

    it('does nothing for non-existent trace', () => {
      const store = new TraceStore(10)
      // Should not throw
      store.updateTrace('non-existent', { related_task_id: 'task-123' })
    })
  })
})
