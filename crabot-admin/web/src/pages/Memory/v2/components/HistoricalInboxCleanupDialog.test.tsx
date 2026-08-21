import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HistoricalInboxCleanupDialog } from './HistoricalInboxCleanupDialog'
import { memoryV2Service } from '../../../../services/memoryV2'

vi.mock('../../../../services/memoryV2', () => ({
  memoryV2Service: {
    previewHistoricalInbox: vi.fn(),
    migrateHistoricalInboxBatch: vi.fn(),
  },
}))

const mocked = memoryV2Service as unknown as {
  previewHistoricalInbox: ReturnType<typeof vi.fn>
  migrateHistoricalInboxBatch: ReturnType<typeof vi.fn>
}

const preview = {
  selection: { legacy_only: true as const },
  estimated_move_count: 201,
  by_type: { fact: 100, lesson: 80, concept: 21 },
  by_age: {
    within_30_days: 1,
    days_31_to_90: 10,
    days_91_to_365: 40,
    over_365_days: 150,
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.previewHistoricalInbox.mockResolvedValue(preview)
})

describe('HistoricalInboxCleanupDialog', () => {
  it('requires an explicit checkbox confirmation after the read-only preview', async () => {
    render(<HistoricalInboxCleanupDialog open onClose={vi.fn()} onMigrated={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('预计迁移')).toBeInTheDocument())
    const migrate = screen.getByRole('button', { name: '迁移下一批（最多 200 条）' })
    expect(migrate).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(migrate).toBeEnabled()
  })

  it('migrates one confirmed batch and refreshes the preview', async () => {
    const onMigrated = vi.fn().mockResolvedValue(undefined)
    mocked.previewHistoricalInbox
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ ...preview, estimated_move_count: 1 })
    mocked.migrateHistoricalInboxBatch.mockResolvedValue({
      selection: { legacy_only: true },
      batch_size: 200,
      moved: 200,
      remaining: 1,
      failed: [],
    })

    render(<HistoricalInboxCleanupDialog open onClose={vi.fn()} onMigrated={onMigrated} />)
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '迁移下一批（最多 200 条）' }))

    await waitFor(() => expect(mocked.migrateHistoricalInboxBatch).toHaveBeenCalledWith(undefined))
    await waitFor(() => expect(onMigrated).toHaveBeenCalledWith(expect.objectContaining({
      moved: 200,
      remaining: 1,
    })))
    expect(mocked.previewHistoricalInbox).toHaveBeenCalledTimes(2)
  })
})
