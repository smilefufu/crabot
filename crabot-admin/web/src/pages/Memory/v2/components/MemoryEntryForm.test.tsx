import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryEntryForm } from './MemoryEntryForm'
import type { MemoryEntryV2 } from '../../../../services/memoryV2'

const sample: MemoryEntryV2 = {
  id: 'mem-l-1', type: 'fact', status: 'confirmed', brief: 'old brief', body: 'old body',
  frontmatter: {
    id: 'mem-l-1', type: 'fact', maturity: 'confirmed',
    brief: 'old brief', author: 'agent:foo',
    source_ref: { type: 'conversation' },
    source_trust: 4, content_confidence: 4,
    importance_factors: { proximity: 0.5, surprisal: 0.5, entity_priority: 0.5, unambiguity: 0.5 },
    entities: [], tags: ['#a', '#b'],
    event_time: '2026-04-23T00:00:00Z', ingestion_time: '2026-04-23T00:00:00Z',
    version: 1,
  },
}

describe('MemoryEntryForm', () => {
  describe('create mode', () => {
    it('renders all fields including type selector', () => {
      render(<MemoryEntryForm mode={{ kind: 'create' }} onCancel={() => {}} onSubmitCreate={async () => {}} />)
      expect(screen.getByLabelText('类型')).toBeInTheDocument()
      expect(screen.getByLabelText('摘要')).toBeInTheDocument()
      expect(screen.getByLabelText('正文')).toBeInTheDocument()
      expect(screen.getByLabelText('标签')).toBeInTheDocument()
    })

    it('submits payload with trust=5 / confidence=5 / manual source', async () => {
      const onSubmitCreate = vi.fn().mockResolvedValue(undefined)
      render(<MemoryEntryForm mode={{ kind: 'create' }} onCancel={() => {}} onSubmitCreate={onSubmitCreate} />)
      fireEvent.change(screen.getByLabelText('摘要'), { target: { value: 'a brief' } })
      fireEvent.change(screen.getByLabelText('正文'), { target: { value: 'body content' } })
      fireEvent.change(screen.getByLabelText('标签'), { target: { value: '#contact, #vip' } })
      fireEvent.click(screen.getByRole('button', { name: '创建记忆' }))
      await waitFor(() => expect(onSubmitCreate).toHaveBeenCalled())
      const arg = onSubmitCreate.mock.calls[0][0]
      expect(arg.brief).toBe('a brief')
      expect(arg.content).toBe('body content')
      expect(arg.tags).toEqual(['#contact', '#vip'])
      expect(arg.source_trust).toBe(5)
      expect(arg.content_confidence).toBe(5)
      expect(arg.source_ref.type).toBe('manual')
    })

    it('disables submit when required fields are empty', () => {
      render(<MemoryEntryForm mode={{ kind: 'create' }} onCancel={() => {}} onSubmitCreate={async () => {}} />)
      const submit = screen.getByRole('button', { name: '创建记忆' }) as HTMLButtonElement
      expect(submit.disabled).toBe(true)
    })

    it('fires onCancel on cancel button', () => {
      const onCancel = vi.fn()
      render(<MemoryEntryForm mode={{ kind: 'create' }} onCancel={onCancel} onSubmitCreate={async () => {}} />)
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
      expect(onCancel).toHaveBeenCalled()
    })
  })

  describe('edit mode', () => {
    it('prefills brief / body / tags from entry and hides type selector', () => {
      render(
        <MemoryEntryForm
          mode={{ kind: 'edit', entry: sample }}
          onCancel={() => {}}
          onSubmitEdit={async () => {}}
        />,
      )
      expect((screen.getByLabelText('摘要') as HTMLInputElement).value).toBe('old brief')
      expect((screen.getByLabelText('正文') as HTMLTextAreaElement).value).toBe('old body')
      expect((screen.getByLabelText('标签') as HTMLInputElement).value).toBe('#a, #b')
      expect(screen.queryByLabelText('类型')).not.toBeInTheDocument()
    })

    it('submits patch { brief, body, tags } on save', async () => {
      const onSubmitEdit = vi.fn().mockResolvedValue(undefined)
      render(
        <MemoryEntryForm
          mode={{ kind: 'edit', entry: sample }}
          onCancel={() => {}}
          onSubmitEdit={onSubmitEdit}
        />,
      )
      fireEvent.change(screen.getByLabelText('摘要'), { target: { value: 'new brief' } })
      fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
      await waitFor(() =>
        expect(onSubmitEdit).toHaveBeenCalledWith('mem-l-1', {
          brief: 'new brief',
          body: 'old body',
          tags: ['#a', '#b'],
        }),
      )
    })
  })
})
