import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminModule from './index.js'

describe('Admin core Agent lifecycle delegation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('never resolves or forwards mutable env when starting the builtin core Agent', async () => {
    const subject = Object.create(AdminModule.prototype) as any
    subject.resolveModuleStartEnv = vi.fn(() => { throw new Error('must not resolve mutable core env') })
    const callModuleManager = vi.fn().mockResolvedValue({status:'accepted',tracking_id:'start'})
    subject.rpcClient = {callModuleManager}; subject.config = {moduleId:'admin-web'}

    await expect(subject.handleStartModuleAdmin({ module_id: 'crabot-agent' })).resolves.toMatchObject({ tracking_id: 'start' })
    expect(subject.resolveModuleStartEnv).not.toHaveBeenCalled()
    expect(callModuleManager.mock.calls[0][1]).toEqual({ module_id: 'crabot-agent' })
  })

  it('never resolves or forwards mutable env when restarting the builtin core Agent', async () => {
    const subject = Object.create(AdminModule.prototype) as any
    subject.resolveModuleStartEnv = vi.fn(() => { throw new Error('must not resolve mutable core env') })
    const callModuleManager = vi.fn().mockResolvedValue({status:'accepted',tracking_id:'restart'})
    subject.rpcClient = {callModuleManager}; subject.config = {moduleId:'admin-web'}

    await expect(subject.handleRestartModuleAdmin({ module_id: 'crabot-agent', force: true })).resolves.toMatchObject({ tracking_id: 'restart' })
    expect(subject.resolveModuleStartEnv).not.toHaveBeenCalled()
    expect(callModuleManager.mock.calls[0][1]).toEqual({ module_id: 'crabot-agent', force: true })
  })
})
