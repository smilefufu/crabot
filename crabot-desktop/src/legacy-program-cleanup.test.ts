import { expect, it, vi } from 'vitest'
import { showLegacyProgramCleanup } from './legacy-program-cleanup.js'
it('does not remove a preview until the human confirms', async () => {
  const removeConfirmed = vi.fn(async () => ({ removed: ['releases/old'], retained: [] }))
  const show = vi.fn(async () => ({ response: 0 }))
  await showLegacyProgramCleanup('/fixture', { showMessageBox: show } as any,
    async () => ({ legacyProgramCleanup: async () => ({ preview: [{ relative: 'releases/old', bytes: 1024 }], retained: [], removeConfirmed }) }))
  expect(removeConfirmed).not.toHaveBeenCalled()
  expect(show.mock.calls[0][0]).toMatchObject({ defaultId: 0, cancelId: 0 })
})
it('shows retained runtime reasons after a confirmed cleanup', async () => {
  const removeConfirmed = vi.fn(async () => ({ removed: [], retained: [{ relative: 'releases/git', reason: 'tail is using it' }] }))
  const show = vi.fn().mockResolvedValueOnce({ response: 1 }).mockResolvedValue({ response: 0 })
  await showLegacyProgramCleanup('/fixture', { showMessageBox: show } as any,
    async () => ({ legacyProgramCleanup: async () => ({ preview: [{ relative: 'releases/git', bytes: 1024 }], retained: [], removeConfirmed }) }))
  expect(removeConfirmed).toHaveBeenCalledOnce()
  expect(show.mock.calls[1][0].detail).toContain('tail is using it')
})
