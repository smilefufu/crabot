import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SceneProfileList } from './SceneProfileList'

const listSceneProfiles = vi.fn()
const toastMock = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}

vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => toastMock,
}))

vi.mock('../../services/memory', async () => {
  const actual = await vi.importActual<typeof import('../../services/memory')>('../../services/memory')
  return {
    ...actual,
    sceneProfileService: {
      ...actual.sceneProfileService,
      list: (...args: unknown[]) => listSceneProfiles(...args),
    },
  }
})

function renderSceneProfileList() {
  return render(
    <MemoryRouter>
      <SceneProfileList />
    </MemoryRouter>,
  )
}

describe('SceneProfileList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows scene profile abstracts and removes section counts from list rows', async () => {
    listSceneProfiles.mockResolvedValue({
      profiles: [
        {
          scene: { type: 'friend', friend_id: 'friend-1' },
          label: 'Alice',
          abstract: '工作搭子',
          overview: '处理工作沟通与需求同步。',
          content: '回复时先确认需求背景，再同步预计交付时间。',
          source_memory_ids: ['mem-1'],
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-20T00:00:00.000Z',
          last_declared_at: '2026-04-20T08:00:00.000Z',
        },
      ],
    })

    renderSceneProfileList()

    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('工作搭子')).toBeInTheDocument()
    expect(screen.queryByText(/Section 数/u)).not.toBeInTheDocument()
  })
})
