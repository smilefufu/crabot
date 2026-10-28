import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../../contexts/ToastContext'
import type { DialogObjectGroupEntry } from '../../../types'
import { GroupWorkbench } from './GroupWorkbench'

afterEach(() => vi.unstubAllGlobals())

it('shows the backfill API error code, reason and log_id in the real toast', async () => {
  const message = '飞书历史消息读取失败（code=99991672，log_id=backfill-log）：Access denied: im:message.group_msg'
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status: 502,
    json: async () => ({ error: message }),
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('localStorage', { getItem: () => null })
  const group: DialogObjectGroupEntry = {
    id: 'group-1',
    channel_id: 'feishu-test',
    type: 'group',
    platform_session_id: 'oc_group',
    title: '产品群',
    participants: [],
    participant_count: 0,
    has_session_config: true,
    master_in_group: true,
    supports_backfill: true,
    created_at: '2026-10-28T00:00:00.000Z',
    updated_at: '2026-10-28T00:00:00.000Z',
  }
  render(<ToastProvider><GroupWorkbench group={group} onEditPermission={() => {}} /></ToastProvider>)

  fireEvent.click(screen.getByRole('button', { name: '回填历史消息' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(`回填历史失败：${message}`)
  expect(screen.getByRole('button', { name: '回填历史消息' })).toBeEnabled()
  expect(fetchMock).toHaveBeenCalledWith('/api/dialog-objects/groups/group-1/backfill-history', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ channel_id: 'feishu-test', max_count: 500 }),
  }))
})
