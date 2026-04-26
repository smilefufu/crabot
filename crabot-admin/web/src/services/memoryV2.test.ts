import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryV2Service } from './memoryV2'
import { api } from './api'

vi.mock('./api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

describe('memoryV2Service', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('listEntries calls GET with type/status query', async () => {
    ;(api.get as any).mockResolvedValue({ items: [] })
    await memoryV2Service.listEntries({ type: 'fact', status: 'confirmed', limit: 50 })
    expect(api.get).toHaveBeenCalledWith('/memory/v2/entries?type=fact&status=confirmed&limit=50')
  })

  it('getEntry calls GET with include=full', async () => {
    ;(api.get as any).mockResolvedValue({})
    await memoryV2Service.getEntry('mem-l-1', { include: 'full' })
    expect(api.get).toHaveBeenCalledWith('/memory/v2/entries/mem-l-1?include=full')
  })

  it('createEntry POSTs body', async () => {
    ;(api.post as any).mockResolvedValue({ id: 'new' })
    const payload = {
      type: 'fact' as const, brief: 'b', content: 'c',
      source_ref: { type: 'manual' as const },
      source_trust: 5, content_confidence: 5,
      importance_factors: { proximity: 0.5, surprisal: 0.5, entity_priority: 0.5, unambiguity: 0.5 },
      event_time: '2026-04-23T00:00:00Z',
      entities: [], tags: [],
    }
    await memoryV2Service.createEntry(payload)
    expect(api.post).toHaveBeenCalledWith('/memory/v2/entries', payload)
  })

  it('patchEntry PATCHes id', async () => {
    ;(api.patch as any).mockResolvedValue({})
    await memoryV2Service.patchEntry('mem-l-1', { brief: 'new' })
    expect(api.patch).toHaveBeenCalledWith('/memory/v2/entries/mem-l-1', { patch: { brief: 'new' } })
  })

  it('deleteEntry DELETEs id', async () => {
    ;(api.delete as any).mockResolvedValue({})
    await memoryV2Service.deleteEntry('mem-l-1')
    expect(api.delete).toHaveBeenCalledWith('/memory/v2/entries/mem-l-1')
  })

  it('restoreEntry POSTs to restore endpoint', async () => {
    ;(api.post as any).mockResolvedValue({})
    await memoryV2Service.restoreEntry('mem-l-1')
    expect(api.post).toHaveBeenCalledWith('/memory/v2/entries/mem-l-1/restore', {})
  })

  it('getEvolutionMode GETs mode', async () => {
    ;(api.get as any).mockResolvedValue({ mode: 'balanced' })
    await memoryV2Service.getEvolutionMode()
    expect(api.get).toHaveBeenCalledWith('/memory/v2/evolution-mode')
  })

  it('setEvolutionMode PUTs mode + reason', async () => {
    ;(api.put as any).mockResolvedValue({})
    await memoryV2Service.setEvolutionMode('innovate', 'low error rate')
    expect(api.put).toHaveBeenCalledWith('/memory/v2/evolution-mode', { mode: 'innovate', reason: 'low error rate' })
  })

  it('getObservationPending GETs observation-pending', async () => {
    ;(api.get as any).mockResolvedValue({ items: [] })
    await memoryV2Service.getObservationPending()
    expect(api.get).toHaveBeenCalledWith('/memory/v2/observation-pending')
  })

  it('runMaintenance POSTs scope', async () => {
    ;(api.post as any).mockResolvedValue({})
    await memoryV2Service.runMaintenance('observation_check')
    expect(api.post).toHaveBeenCalledWith('/memory/v2/maintenance/run', { scope: 'observation_check' })
  })
})
