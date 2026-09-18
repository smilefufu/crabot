import { describe, expect, it, vi } from 'vitest'
import AdminModule from './index.js'

const start = '2026-09-16T18:00:00.000Z'
const end = '2026-09-17T18:00:00.000Z'
const params = { schedule_id: 'daily', trigger_id: 'trigger', window_start: start, window_end: end }
const context = { authorizationBearer: 'runtime-test' }

function subject() {
  const admin = Object.create(AdminModule.prototype) as any
  admin.config = { moduleId: 'crabot-admin' }
  admin.dailyReflectionTriggers = new Map()
  admin.dataLoaded = true
  admin.schedules = new Map([['daily', {
    id: 'daily', is_builtin: true, task_template: { type: 'daily_reflection' },
    created_at: start, watermark: start, execution_count: 2,
  }]])
  admin.rpcClient = { callModuleManagerSensitive: vi.fn().mockResolvedValue({ verified: true }) }
  admin.saveData = vi.fn().mockResolvedValue(undefined)
  return admin
}

describe('daily reflection completion', () => {
  it('dispatch freezes a structured window and later statistics do not overwrite a concurrent completion', async () => {
    const admin = subject()
    const schedule = { ...admin.schedules.get('daily'), name: 'daily', trigger: { type: 'cron', expression: '0 2 * * *' },
      task_template: { type: 'daily_reflection', title: 'daily', description: 'review' } }
    admin.schedules.set('daily', schedule)
    admin.assertIngressOpen = () => undefined
    admin.repairScheduleTargetSessionReference = async (value: unknown) => value
    admin.ensureAgentPort = async () => 9999
    admin.calculateNextTriggerTime = () => '2026-09-19T18:00:00.000Z'
    admin.publishAdminEvent = () => undefined
    admin.rpcClient.callSensitive = vi.fn(async (_port, _method, payload) => {
      expect(payload.reflection_proof).toMatch(/^[a-f0-9]{64}$/)
      const { reflection_proof, ...bound } = payload
      const { sha256CanonicalJson } = await import('crabot-shared')
      const verification = { proof: reflection_proof, payload_sha256: sha256CanonicalJson(bound) }
      await expect(admin.handleConsumeDailyReflectionTrigger(verification)).rejects.toThrow('credential')
      await expect(admin.handleConsumeDailyReflectionTrigger({ ...verification, payload_sha256: 'tampered' }, context)).rejects.toThrow('trigger proof')
      expect(await admin.handleConsumeDailyReflectionTrigger(verification, context)).toEqual({ consumed: true })
      await expect(admin.handleConsumeDailyReflectionTrigger(verification, context)).rejects.toThrow('trigger proof')
      expect(payload.reflection_window.window_start).toBe(start)
      expect(Date.parse(payload.reflection_window.window_end)).toBeGreaterThan(Date.parse(start))
      admin.schedules.set('daily', { ...schedule, watermark: payload.reflection_window.window_end })
      return { accepted: true }
    })
    await admin.handleScheduleTrigger(schedule)
    expect(admin.schedules.get('daily').watermark).toBe(admin.rpcClient.callSensitive.mock.calls[0][2].reflection_window.window_end)
    expect(admin.schedules.get('daily').execution_count).toBe(3)
    expect(admin.dailyReflectionTriggers.size).toBe(0)
  })

  it('rejects a trigger proof after Admin restart', async () => {
    const admin = subject()
    await expect(admin.handleConsumeDailyReflectionTrigger({ proof: 'old-proof', payload_sha256: 'old-hash' }, context)).rejects.toThrow('trigger proof')
  })

  it('authenticates core Agent and persists the frozen end, then accepts a duplicate', async () => {
    const admin = subject()
    expect(await admin.handleCompleteDailyReflection(params, context)).toEqual({ status: 'applied', watermark: end })
    expect(admin.rpcClient.callModuleManagerSensitive).toHaveBeenCalledWith(
      'verify_core_agent_runtime', { expected_module_id: 'crabot-agent' }, 'crabot-admin', context,
    )
    expect(admin.saveData).toHaveBeenCalled()
    expect(await admin.handleCompleteDailyReflection(params, context)).toEqual({ status: 'already_applied', watermark: end })
  })

  it('never advances for absent or invalid runtime credentials', async () => {
    const admin = subject()
    await expect(admin.handleCompleteDailyReflection(params)).rejects.toThrow()
    admin.rpcClient.callModuleManagerSensitive.mockRejectedValue(new Error('invalid runtime'))
    await expect(admin.handleCompleteDailyReflection(params, context)).rejects.toThrow('invalid runtime')
    expect(admin.schedules.get('daily').watermark).toBe(start)
    expect(admin.saveData).not.toHaveBeenCalled()
  })

  it.each([
    { is_builtin: false }, { task_template: { type: 'other' } }, { script: { source: 'x' } },
  ])('rejects a user lookalike or changed schedule %j', async patch => {
    const admin = subject()
    Object.assign(admin.schedules.get('daily'), patch)
    await expect(admin.handleCompleteDailyReflection(params, context)).rejects.toThrow()
    expect(admin.saveData).not.toHaveBeenCalled()
  })

  it('rejects invalid windows and a conflicting watermark without overwriting', async () => {
    const admin = subject()
    for (const patch of [{ window_start: end }, { window_end: 'bad' }, { window_end: '2999-01-01T00:00:00.000Z' }, { trigger_id: '' }]) {
      await expect(admin.handleCompleteDailyReflection({ ...params, ...patch }, context)).rejects.toThrow()
    }
    admin.schedules.get('daily').watermark = '2026-09-18T00:00:00.000Z'
    await expect(admin.handleCompleteDailyReflection(params, context)).rejects.toThrow(/watermark/)
    expect(admin.schedules.get('daily').watermark).toBe('2026-09-18T00:00:00.000Z')
  })

  it('failed persistence cannot be mistaken for an applied duplicate', async () => {
    const admin = subject()
    admin.saveData.mockRejectedValueOnce(new Error('disk failed'))
    await expect(admin.handleCompleteDailyReflection(params, context)).rejects.toThrow('disk failed')
    expect(admin.schedules.get('daily').watermark).toBe(start)
    expect(await admin.handleCompleteDailyReflection(params, context)).toEqual({ status: 'applied', watermark: end })
  })

  it('serializes concurrent confirmations across persistence failure', async () => {
    const admin = subject()
    let rejectSave!: (error: Error) => void
    admin.saveData.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject }))
    const first = admin.handleCompleteDailyReflection(params, context)
    const second = admin.handleCompleteDailyReflection(params, context)
    const results = Promise.allSettled([first, second])
    await vi.waitFor(() => expect(rejectSave).toBeTypeOf('function'))
    rejectSave(new Error('disk failed'))
    expect(await results).toMatchObject([
      { status: 'rejected' }, { status: 'fulfilled', value: { status: 'applied', watermark: end } },
    ])
  })
})
