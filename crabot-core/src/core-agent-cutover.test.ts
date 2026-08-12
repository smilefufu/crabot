import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ModuleManager from './index.js'

describe('core Agent cutover gate', () => {
  it('starts only Admin, rejects pre-cutover ingress, then persists completion before starting core modules', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-cutover-'))
    const manager = new ModuleManager({
      port: 0,
      port_range: { range_start: 19800, range_end: 19820 },
      health_check_interval: 60,
      health_check_timeout: 1,
      health_check_failure_threshold: 3,
      shutdown_timeout: 1,
      hotplug_allowed_types: ['channel'],
      modules: [
        { module_id: 'admin-web', module_type: 'admin', entry: 'node -e "setTimeout(()=>{}, 10000)"', auto_start: true, start_priority: 1 },
        { module_id: 'crabot-agent', module_type: 'agent', entry: 'node -e "setTimeout(()=>{}, 10000)"', auto_start: true, start_priority: 2 },
        { module_id: 'memory-default', module_type: 'memory', entry: 'node -e "setTimeout(()=>{}, 10000)"', auto_start: true, start_priority: 3 },
      ],
    }, dataDir)
    try {
      await manager.start()
      await new Promise((resolve) => setTimeout(resolve, 30))
      await expect((manager as any).handleStartModule({ module_id: 'memory-default' })).rejects.toMatchObject({ code: 'MODULE_MANAGER_CUTOVER_INCOMPLETE' })
      expect(() => (manager as any).handleResolve({ module_id: 'crabot-agent' })).toThrow(/cutover/)
      expect(() => (manager as any).handleSubscribe({ subscriber: 'memory-default', event_types: [] })).toThrow(/cutover/)
      expect(() => (manager as any).handleRegisterModuleDefinition({ module_definition: { module_id: 'rogue-agent', module_type: 'agent', entry: 'node -e 1', auto_start: false, start_priority: 4 } })).toThrow(/cutover|builtin/)
      const bearer = (manager as any).cutoverBearers.get('admin-web')
      expect(bearer).toBeDefined()
      const result = await (manager as any).handleCompleteCoreAgentCutover({ schema_version: 1, admin_archive_fingerprint: 'a', admin_archived_record_count: 0 }, { authorizationBearer: bearer.token })
      expect(result.completed).toBe(true)
      const replay = await (manager as any).handleCompleteCoreAgentCutover({ schema_version: 1, admin_archive_fingerprint: 'a', admin_archived_record_count: 0 }, { authorizationBearer: bearer.token })
      expect(replay).toEqual(result)
      expect(JSON.parse(await fs.readFile(path.join(dataDir, 'migrations', 'core-agent-singleton-v1.json'), 'utf8')).completed).toBe(true)
    } finally {
      await manager.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
