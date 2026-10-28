import { it, expect, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ModuleManager from './index.js'

// Windows cleanup includes several bounded OS process-tree queries.
it.each(['crabot-agent', 'admin-web', 'custom-module'])('the actual %s child receives only its own management credentials', async id => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crabot-module-env-'))
  const script = path.join(directory, 'child.cjs'), output = path.join(directory, 'result.json')
  await writeFile(script, 'require("node:fs").writeFileSync(process.argv[2],JSON.stringify({keys:Object.keys(process.env),bearer:!!process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER,custom:process.env.TEST_CUSTOM,path:!!(process.env.PATH||process.env.Path)}));setInterval(()=>{},1000)')
  const mm = new ModuleManager({ modules: [], shutdown_timeout: 1 }, directory) as any
  mm.publishEvent = vi.fn(async () => {})
  mm.modules.set(id, { module_id: id, module_type: id === 'crabot-agent' ? 'agent' : 'admin', entry: `"${process.execPath}" "${script}" "${output}"`, cwd: directory,
    env: { CRABOT_JWT_SECRET: 'fixture-runtime-secret', CRABOT_ADMIN_PASSWORD: 'fixture-password',
      CRABOT_ADMIN_CUTOVER_BEARER: 'fixture-cutover', crabot_jwt_secret: 'fixture-mixed-case', TEST_CUSTOM: 'preserved' },
    auto_start: false, auto_restart: false, skip_health_check: true,
    start_priority: 1, status: 'stopped', port: 29991 })
  try {
    await mm.startModuleProcess(id)
    let result: any
    await vi.waitFor(async () => { result = JSON.parse(await readFile(output, 'utf8')); expect(result.bearer).toBe(id === 'crabot-agent') }, { timeout: 5000 })
    expect(result.custom).toBe('preserved'); expect(result.path).toBe(true)
    const keys = result.keys.map((key: string) => key.toUpperCase())
    for (const key of ['CRABOT_JWT_SECRET', 'CRABOT_ADMIN_PASSWORD', 'CRABOT_ADMIN_CUTOVER_BEARER']) {
      expect(keys.includes(key)).toBe(id === 'admin-web')
    }
  } finally {
    // The public RPC only acknowledges scheduling; cleanup must await actual exit.
    await mm.stopModuleProcess(id, 'shutdown')
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 30_000)
