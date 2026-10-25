// Finite source-image fixture, not Electron or the product uninstall entry.
// It proves real parent/child and IPC/locks with inert program/data fixtures.
const fs = require('node:fs/promises'), path = require('node:path')
const { pathToFileURL } = require('node:url'), { spawn } = require('node:child_process'), { once } = require('node:events')
const cfg = JSON.parse(process.env.CRABOT_NODE_REMOVAL_FIXTURE)
const load = name => import(pathToFileURL(path.join(cfg.own.guiRoot, 'resources/crabot-maintenance-backend/bootstrap/scripts/lib', name)))
const timer = setTimeout(() => process.exit(2), 45000)
let prepared, child, ended
void (async () => {
  const { prepareDesktopRemovalNode } = await load('desktop-removal-host.mjs')
  prepared = await prepareDesktopRemovalNode({ installRoot: cfg.own.root, operationId: cfg.operationId })
  if (cfg.mode === 'node-job-copy-changed') await fs.appendFile(path.join(prepared.directory, 'backend/progress.mjs'), '\n// changed fixture bytes\n')
  const script = `
    const timer=setTimeout(()=>process.exit(2),30000);process.once('disconnect',()=>process.exit(2));
    const {pathToFileURL}=await import('node:url'),path=await import('node:path'),{createRequire}=await import('node:module');
    const require=createRequire(pathToFileURL(path.join(process.cwd(),'backend/probe.cjs')));
    const identity=require('./bootstrap/scripts/lib/process-identity.cjs'),entry=require('./bootstrap/scripts/lib/desktop-entry.cjs');
    const installation=require('./bootstrap/scripts/lib/desktop-installation.cjs');
    let lease;
    try {
      const ordinaryPeer=entry.verifyDesktopEntry(identity.inspectProcess(process.pid),entry.loadDesktopEntry(installation.readDesktopSelection(process.argv[1]).coreRoot));
      const {beginInitialDesktopRemovalNode}=await import(pathToFileURL(path.join(process.cwd(),'backend/bootstrap/scripts/lib/desktop-removal-job.mjs')));
      lease=await beginInitialDesktopRemovalNode({installRoot:process.argv[1],operationId:process.argv[2]});
      const published=await lease.current();await lease.stop();const stopped=await lease.current();await lease.cancel();lease.close();lease=null;
      process.stdout.write(JSON.stringify({accepted:true,published:published.phase,stopped:stopped.phase,cancelled:true,ordinary_peer:ordinaryPeer})+'\\n');
    } catch(error) { if(lease)lease.close();process.stdout.write(JSON.stringify({accepted:false,code:error.code||'FIXTURE_UNEXPECTED'})+'\\n') }
    clearTimeout(timer);process.disconnect();
  `
  const root = cfg.otherRoot || cfg.own.root
  child = spawn(prepared.executable, ['--input-type=module', '--eval', script, root, cfg.operationId], {
    cwd: prepared.directory, env: { PATH: '', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  ended = once(child, 'close')
  let output = '', error = ''
  child.stdout.on('data', bytes => { output += bytes.toString(); if (output.length > 4096) child.kill('SIGKILL') })
  child.stderr.on('data', bytes => { error = (error + bytes.toString()).slice(-4096) })
  const [code, signal] = await ended
  if (code !== 0 || signal || error) throw new Error('Finite Node host failed: ' + error)
  const result = JSON.parse(output)
  await fs.rm(prepared.directory, { recursive: true, force: true }); prepared = null
  clearTimeout(timer); process.stdout.write(JSON.stringify(result) + '\n')
})().catch(async error => {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended.catch(() => {}) }
  if (prepared) await fs.rm(prepared.directory, { recursive: true, force: true })
  clearTimeout(timer); console.error(error); process.exitCode = 1
})
