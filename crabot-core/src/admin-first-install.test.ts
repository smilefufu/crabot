import { expect, it, onTestFinished, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import ModuleManager from './index.js'
import { buildCoreModules } from './core-modules.js'

for (const [moduleId, existing, permissions] of [
  ['admin-web', false, []],
  ['admin-web', true, { error: 'ENOENT' }],
  ['admin-web', true, [{ friend_id: 'old', storage_override: { scope: 'all', access: 'readwrite' } }]],
  ['other-module', false, { error: 'ENOENT' }],
] as const) it(`first permission-store initialization is scoped to a new Admin: ${moduleId}/${existing}/${Array.isArray(permissions) ? permissions.length : 'missing'}`, async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-admin-first-'))
  const moduleDir = path.join(root, 'crabot-admin'), dataDir = path.join(root, 'data/admin'), marker = path.join(root, 'observed.json')
  let child: import('node:child_process').ChildProcess | undefined, state: any
  const mm = new ModuleManager({ modules: [], shutdown_timeout: 0.1 }, path.join(root, 'data')) as any
  mm.publishEvent = vi.fn(async () => {})
  onTestFinished(async () => {
    child ??= mm.processes.get(moduleId); state ??= child && mm.childStates.get(child)
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }
    if (state) await state.finalized
    await fs.rm(root, { recursive: true, force: true })
  })
  await fs.mkdir(path.join(moduleDir, 'dist'), { recursive: true })
  if (existing) { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(path.join(dataDir, 'SCHEMA_VERSION'), 'v1\n') }
  if (existing && Array.isArray(permissions)) await fs.writeFile(path.join(dataDir, 'friend-permission-configs.json'), JSON.stringify(permissions))
  await fs.writeFile(path.join(moduleDir, 'schema_version'), 'v1\n')
  const entry = path.join(moduleDir, 'dist/main.js')
  await fs.writeFile(entry, `const fs=require('node:fs'),path=require('node:path');
const data=${JSON.stringify(dataDir)};let permissions,schema=null;
try{permissions=JSON.parse(fs.readFileSync(path.join(data,'friend-permission-configs.json'),'utf8'))}catch(error){permissions={error:error.code}}
try{schema=fs.readFileSync(path.join(data,'SCHEMA_VERSION'),'utf8').trim()}catch(error){if(error.code!=='ENOENT')throw error}
fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({schema,permissions}));
setTimeout(()=>process.exit(0),30000);process.on('SIGTERM',()=>process.exit(0));`)
  const builtIn = buildCoreModules({ crabotRoot: root, adminDir: moduleDir, agentDir: path.join(root, 'crabot-agent'), memoryDir: path.join(root, 'crabot-memory'),
    dataDir: path.join(root, 'data'), workspaceDir: root, isDev: false, port: 19000, adminRpcPort: '19001', adminWebPort: '3000',
    mmEndpoint: 'http://127.0.0.1:19000', adminEndpoint: 'http://127.0.0.1:19001', newApiToken: '' }).find(module => module.module_id === 'admin-web')!
  mm.modules.set(moduleId, { ...(moduleId === 'admin-web' ? builtIn : { module_id: moduleId, module_type: 'memory', cwd: moduleDir, data_dir: dataDir }),
    entry: `"${process.execPath}" "${entry}"`, auto_start: false, auto_restart: false, skip_health_check: true, start_priority: 1, status: 'stopped', port: 28999 })
  await mm.startModuleProcess(moduleId)
  child = mm.processes.get(moduleId); state = child && mm.childStates.get(child)
  const deadline = Date.now() + 5000
  while (!await fs.stat(marker).catch(() => null) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  const observed = JSON.parse(await fs.readFile(marker, 'utf8'))
  if (moduleId === 'admin-web' && !existing) {
    await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(path.join(dataDir, 'friends.json'), '[{"id":"new-object","permission":"normal"}]\n')
    const { scanModules } = await import(new URL('../../scripts/upgrade-lib/migrate.mjs', import.meta.url).href)
    const pending = scanModules(root, path.join(root, 'data')).some((module: { moduleId: string }) => module.moduleId === 'crabot-admin')
    expect({ observed, pending }).toEqual({ observed: { schema: 'v1', permissions }, pending: false })
  } else expect(observed).toEqual({ schema: 'v1', permissions })
}, 15000)
