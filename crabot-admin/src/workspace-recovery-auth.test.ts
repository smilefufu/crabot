import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { observeCurrentWorkspaceAdmin } from './workspace-recovery-auth.js'
const native = require('../../scripts/lib/process-identity.cjs')
const management = require('../../scripts/lib/desktop-management.cjs')

describe('current Admin observation under an existing legacy data root', () => {
  let root: string | undefined
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }) })
  it.skipIf(process.platform === 'win32')('accepts a legacy 0755 root without chmod while retaining exact runtime identities', () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-legacy-admin-observation-')))
    const data = management.ensurePrivateDataRoot(path.join(root, 'data')), directory = management.ensurePrivateDataRoot(path.join(data, 'module-runtime-registry'))
    const records = management.ensurePrivateDataRoot(path.join(directory, 'records')), instanceId = randomUUID(), runtimeId = randomUUID(), identity = native.inspectProcess(process.pid)
    fs.writeFileSync(path.join(records, runtimeId + '.json'), JSON.stringify({ schema_version: 1, instance_id: instanceId, runtime_id: runtimeId,
      module_id: 'admin-web', root_pid: process.pid, process_start_identity: identity.started, module_port: 19801, created_at: new Date().toISOString() }), { mode: 0o600 })
    fs.chmodSync(data, 0o755)
    const options = { dataDir: data, moduleManagerPort: 19800, modulePort: 19801,
      runtimeIdentity: () => ({ instance_id: instanceId, module_id: 'admin-web', runtime_id: runtimeId }) }
    const current = observeCurrentWorkspaceAdmin(options)
    current.verify()
    expect(fs.statSync(data).mode & 0o777).toBe(0o755)
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700)
    expect(fs.statSync(records).mode & 0o777).toBe(0o700)
    fs.chmodSync(data, 0o777)
    expect(() => observeCurrentWorkspaceAdmin(options)).toThrow()
    fs.chmodSync(data, 0o755)
    fs.writeFileSync(path.join(records, runtimeId + '.json'), '{}', { mode: 0o600 })
    expect(() => current.verify()).toThrow()
  })
})
