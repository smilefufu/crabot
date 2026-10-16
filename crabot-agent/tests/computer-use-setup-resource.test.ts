import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnifiedAgent } from '../src/unified-agent.js'
import { ConfigLoader } from '../src/core/config-loader.js'
afterEach(() => vi.restoreAllMocks())
function fixture() {
  const agent: any = Object.create(UnifiedAgent.prototype)
  const product = { name: 'computer-use', command: 'node', args: ['/fixture/crabot-mcp-tools/dist/computer-use/main.js', '--crabot-standard'] }
  const snapshot = { mcp_servers: [product, { name: 'other', command: 'fixture' }] }
  agent.agentConfig = snapshot; agent.configRevision = 7; agent.configStale = false; agent.runtimeClosing = false; agent.configResourcesDetached = false
  agent.getAdminPort = async () => 19998
  agent.config = { moduleId: 'crabot-agent' }; agent.rpcClient = {}
  agent.computerUseOwner = { status: { state: 'uninitialized' }, prepare: vi.fn().mockResolvedValue([product]), close: vi.fn(),
    verifySetup: vi.fn(), cancelSetupVerification: vi.fn() }
  agent.mcpConnector = { connectComputerUse: vi.fn().mockResolvedValue(undefined), disconnectAll: vi.fn().mockResolvedValue(undefined), reconnect: vi.fn() }
  return { agent, product, snapshot }
}
describe('desktop setup authenticated local resource repair', () => {
  it('equal revision reconnects only the enabled standard server without model/config/task mutation', async () => {
    const { agent, snapshot, product } = fixture()
    vi.spyOn(ConfigLoader, 'pull').mockResolvedValue({ revision: 7, config: { agent_config: snapshot } } as never)
    await agent.pullRuntimeConfig()
    expect(agent.computerUseOwner.prepare).toHaveBeenCalledWith([product])
    expect(agent.mcpConnector.connectComputerUse).toHaveBeenCalledWith(product, expect.any(Function))
    expect(agent.mcpConnector.disconnectAll).not.toHaveBeenCalled()
    expect(agent.mcpConnector.reconnect).not.toHaveBeenCalled()
    expect(agent.agentConfig).toBe(snapshot)
    expect(agent.configRevision).toBe(7)
    expect(agent.configAuthenticated).toBe(true)
  })
  it('resource failure does not fail closed the entire authenticated config or other MCPs', async () => {
    const { agent, snapshot } = fixture()
    vi.spyOn(ConfigLoader, 'pull').mockResolvedValue({ revision: 7, config: { agent_config: snapshot } } as never)
    agent.computerUseOwner.prepare.mockRejectedValue(new Error('COMPUTER_USE_SCREEN_RECORDING_REQUIRED'))
    await agent.pullRuntimeConfig()
    expect(agent.configStale).toBe(false)
    expect(agent.mcpConnector.disconnectAll).not.toHaveBeenCalled()
  })
  it('does not use setup as business quarantine recovery, and discards a late prepared bridge after shutdown', async () => {
    const { agent, product } = fixture()
    agent.computerUseOwner.status.state = 'quarantined'
    await agent.refreshComputerUseResource()
    expect(agent.computerUseOwner.prepare).not.toHaveBeenCalled()
    agent.computerUseOwner.status.state = 'uninitialized'
    let ready!: (configs: unknown) => void
    agent.computerUseOwner.prepare.mockImplementation(() => new Promise(resolve => { ready = resolve }))
    const repairing = agent.refreshComputerUseResource()
    agent.runtimeClosing = true; ready([product]); await repairing
    expect(agent.mcpConnector.connectComputerUse).not.toHaveBeenCalled()
    expect(agent.computerUseOwner.close).toHaveBeenCalledTimes(1)
  })
  it('ignores stale pull setup metadata instead of granting a diagnostic from an event', async () => {
    const { agent, snapshot } = fixture()
    vi.spyOn(ConfigLoader, 'pull').mockResolvedValue({ revision: 6, config: { agent_config: snapshot }, computer_use_setup: { setup_id: 'foreign', expires_at: new Date(Date.now() + 60000).toISOString() } } as never)
    await agent.pullRuntimeConfig()
    expect(agent.computerUseOwner.verifySetup).not.toHaveBeenCalled()
    expect(agent.computerUseOwner.prepare).not.toHaveBeenCalled()
  })
})
