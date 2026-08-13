import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ModuleInstaller } from './module-installer.js'
import type { ModulePackageInfo } from './types.js'

const AGENT_PACKAGE: ModulePackageInfo = {
  module_id: 'third-party-agent',
  module_type: 'agent',
  protocol_version: '0.1.0',
  name: 'Third-party Agent',
  version: '1.0.0',
  runtime: { type: 'nodejs' },
  entry: 'index.js',
  install: 'pnpm install',
  build: 'pnpm build',
  agent: {
    engine: 'custom',
    supported_roles: ['worker'],
    model_format: 'openai',
    model_roles: [],
  },
}

describe('ModuleInstaller dynamic Agent defense in depth', () => {
  let dataDir: string
  let installer: ModuleInstaller
  let internals: any
  let agentManager: {
    getImplementation: ReturnType<typeof vi.fn>
    addImplementation: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-module-installer-agent-'))
    agentManager = {
      getImplementation: vi.fn(),
      addImplementation: vi.fn(),
    }
    installer = new ModuleInstaller(dataDir, agentManager as never)
    await installer.initialize()
    internals = installer as any
    internals.prepareSource = vi.fn()
    internals.validator.validate = vi.fn().mockResolvedValue(AGENT_PACKAGE)
    internals.runtimeManager.checkRuntime = vi.fn().mockResolvedValue(true)
    internals.runtimeManager.runInstall = vi.fn()
    internals.runtimeManager.runBuild = vi.fn()
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('preview rejects an Agent package even if the validator seam returns one', async () => {
    await expect(installer.preview({ type: 'local', path: '/unused' }))
      .rejects.toThrow('ADMIN_HOTPLUG_NOT_ALLOWED')

    expect(internals.runtimeManager.runInstall).not.toHaveBeenCalled()
    expect(internals.runtimeManager.runBuild).not.toHaveBeenCalled()
    expect(await fs.readdir(path.join(dataDir, 'temp'))).toEqual([])
  })

  it('install rejects before runtime/install/build, final rename, or record creation', async () => {
    await expect(installer.install({ type: 'local', path: '/unused' }))
      .rejects.toThrow('ADMIN_HOTPLUG_NOT_ALLOWED')

    expect(agentManager.getImplementation).not.toHaveBeenCalled()
    expect(internals.runtimeManager.checkRuntime).not.toHaveBeenCalled()
    expect(internals.runtimeManager.runInstall).not.toHaveBeenCalled()
    expect(internals.runtimeManager.runBuild).not.toHaveBeenCalled()
    expect(agentManager.addImplementation).not.toHaveBeenCalled()
    expect(await fs.readdir(path.join(dataDir, 'temp'))).toEqual([])
    expect(await fs.readdir(path.join(dataDir, 'installed-modules'))).toEqual([])
  })
})
