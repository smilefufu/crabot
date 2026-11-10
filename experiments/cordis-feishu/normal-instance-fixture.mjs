import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import identity from '../../scripts/lib/process-identity.cjs'
import scope from '../../scripts/lib/owned-process-tree.cjs'
export const normalFixtureRoot = path.resolve(process.env.CORDIS_CORE_ROOT ?? fileURLToPath(new URL('../..', import.meta.url)))
const root = normalFixtureRoot
const moduleUrl = file => pathToFileURL(path.join(root, file)).href

// The fixture uses the normal launcher and migrations, with temporary synthetic data only.
export function launchNormalFixture(directory, web, { preload, initializeCredentials = false } = {}) {
  const program = `
    import {prepareCoreEnvironment,applyStartupMigrations} from ${JSON.stringify(moduleUrl('scripts/lib/core-preparation.mjs'))}
    import {acquireStartupLock,releaseCliLock} from ${JSON.stringify(moduleUrl('scripts/lib/cli-lock.mjs'))}
    import {runManagedCore} from ${JSON.stringify(moduleUrl('scripts/lib/managed-core.mjs'))}
    import {probeHealthStatus,probeMmModules} from ${JSON.stringify(moduleUrl('scripts/lib/mm-probe.mjs'))}
    const root=${JSON.stringify(root)},dataDir=${JSON.stringify(directory)},mmPort=19339
    const lock=await acquireStartupLock(dataDir,'normal-cordis-fixture')
    const prepared=prepareCoreEnvironment({root,dataDir,loadInstallationEnv:false,source:process.env})
    ${initializeCredentials ? `const {writeCredentials,newCredentialsFromPassword}=await import(${JSON.stringify(moduleUrl('crabot-admin/dist/credentials.js'))});
    await writeCredentials(dataDir+'/admin',await newCredentialsFromPassword('synthetic-test-only',{is_temp:false,changed_via:'start'}));` : ''}
    await applyStartupMigrations(root,dataDir,prepared.env)
    const {mm}=await runManagedCore({root,dataDir,mmPort,env:prepared.env,stdio:['ignore','inherit','inherit'],cleanup:code=>process.exit(code)})
    const deadline=Date.now()+30000
    while(Date.now()<deadline){
      if(mm.exitCode!==null||mm.signalCode!==null)throw new Error('Normal Core exited before readiness')
      const modules=await probeMmModules(mmPort,undefined,{dataDir})
      if(modules?.filter(item=>['admin-web','crabot-agent','memory-default'].includes(item.module_id)&&item.status==='running').length===3){
        const health=await probeHealthStatus(mmPort,undefined,{dataDir})
        if(['healthy','degraded'].includes(health)){releaseCliLock(lock);process.send({type:'ready',pid:mm.pid,modules});break}
      }
      await new Promise(resolve=>setTimeout(resolve,50))
    }
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], { cwd: root,
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
      DATA_DIR: directory, WORKSPACE_DIR: directory, ...(preload ? { NODE_OPTIONS: `--require ${preload}` } : {}), UV_OFFLINE: '1', CRABOT_DEV: 'false', CRABOT_PRODUCT_REQUIRED: '0',
      CRABOT_ADMIN_PASSWORD: 'synthetic-test-only', CRABOT_ADMIN_WEB_HOST: '127.0.0.1',
      CRABOT_ADMIN_WEB_PORT: String(web), CRABOT_PORT_OFFSET: '0', PORT: '19339', PORT_RANGE_START: '24301', PORT_RANGE_END: '24310' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const exited = once(child, 'exit')
  const ready = Promise.race([once(child, 'message', { signal: AbortSignal.timeout(40_000) }),
    exited.then(([code]) => { throw new Error(`Controller exited ${code}`) })])
  void ready.catch(() => {})
  return { child, exited, ready, output: () => output }
}

// Include grandchildren such as the production Python carrier, not only registered roots.
export function observeInstanceListeners(mmPid) {
  return scope.captureOwnedProcessTree([identity.inspectProcess(mmPid)])
    .map(process => ({ pid: process.pid, ports: identity.listListeningTcpPorts(process.pid) }))
}
