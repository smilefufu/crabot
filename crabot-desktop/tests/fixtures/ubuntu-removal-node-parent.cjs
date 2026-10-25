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
    const timer=setTimeout(()=>process.exit(2),30000),parentLost=()=>process.exit(2);process.once('disconnect',parentLost);
    const {pathToFileURL}=await import('node:url'),path=await import('node:path'),{createRequire}=await import('node:module');
    const require=createRequire(pathToFileURL(path.join(process.cwd(),'backend/probe.cjs')));
    const identity=require('./bootstrap/scripts/lib/process-identity.cjs'),entry=require('./bootstrap/scripts/lib/desktop-entry.cjs');
    const installation=require('./bootstrap/scripts/lib/desktop-installation.cjs');
    let lease;
    const probe=message=>new Promise((resolve,reject)=>{process.once('message',value=>value?.kind==='fixture_source_verification'?resolve(value.accepted):reject(new Error('bad fixture reply')));process.send(message,error=>{if(error)reject(error)})});
    try {
      const ordinaryPeer=entry.verifyDesktopEntry(identity.inspectProcess(process.pid),entry.loadDesktopEntry(installation.readDesktopSelection(process.argv[1]).coreRoot));
      const {beginInitialDesktopRemovalNode}=await import(pathToFileURL(path.join(process.cwd(),'backend/bootstrap/scripts/lib/desktop-removal-job.mjs')));
      lease=await beginInitialDesktopRemovalNode({installRoot:process.argv[1],operationId:process.argv[2]});
      const published=await lease.current(),message={kind:'desktop_removal_source_exit',installation_id:published.installation_id,operation_id:published.operation_id,source_selection:published.source_selection};
      let sourceVerifier;
      if(process.argv[3]==='node-job-source-verifier')sourceVerifier={preparing_rejected:await probe(message)===false};
      await lease.stop();const stopped=await lease.current();
      let sourceExited;
      if(process.argv[3]==='node-job-source-exit'){process.removeListener('disconnect',parentLost);sourceExited=(await lease.exitSource()).source_exited}
      if(sourceVerifier){
        sourceVerifier.wrong_operation_rejected=await probe({...message,operation_id:'00000000-0000-4000-8000-000000000000'})===false;
        sourceVerifier.verified_after_stop=await probe(message)===true;
        const fs=await import('node:fs/promises'),file=path.join(process.cwd(),'backend/progress.mjs'),bytes=await fs.readFile(file);
        await fs.appendFile(file,'\\n// changed fixture copy\\n');sourceVerifier.changed_copy_rejected=await probe(message)===false;await fs.writeFile(file,bytes);
      }
      await lease.cancel();lease.close();lease=null;
      const locks=await import(pathToFileURL(path.join(process.cwd(),'backend/bootstrap/scripts/lib/cli-lock.mjs')));
      const rootLock=await locks.acquireExistingCliLock(process.argv[1],'fixture-reacquire',0);
      try{const dataLock=await locks.acquireExistingCliLock(path.join(process.argv[1],'data'),'fixture-reacquire',0);locks.releaseCliLock(dataLock)}finally{locks.releaseCliLock(rootLock)}
      const result={accepted:true,published:published.phase,stopped:stopped.phase,cancelled:true,ordinary_peer:ordinaryPeer,locks_reacquired:true,...(sourceVerifier?{source_verifier:sourceVerifier}:{}),...(sourceExited?{source_exited:sourceExited}:{})};
      if(process.argv[3]==='node-job-source-exit')await(await import('node:fs/promises')).writeFile(process.argv[4],JSON.stringify(result));
      else process.stdout.write(JSON.stringify(result)+'\\n');
    } catch(error) { if(lease)lease.close();process.stdout.write(JSON.stringify({accepted:false,code:error.code||'FIXTURE_UNEXPECTED'})+'\\n') }
    clearTimeout(timer);process.removeListener('disconnect',parentLost);if(process.connected)process.disconnect();
  `
  const root = cfg.otherRoot || cfg.own.root
  child = spawn(prepared.executable, ['--input-type=module', '--eval', script, root, cfg.operationId, cfg.mode, cfg.resultFile], {
    cwd: prepared.directory, env: { PATH: '', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  if (['node-job-source-verifier', 'node-job-source-exit'].includes(cfg.mode)) {
    const verifier = load('desktop-removal-source.mjs').then(module => module.createDesktopRemovalNodeSourceExitVerifier({ installRoot: cfg.own.root, prepared, child }))
    child.on('message', async message => {
      const accepted = await (await verifier)(message)
      if (cfg.mode === 'node-job-source-exit') {
        if (!accepted) throw new Error('Fixture source exit was rejected')
        const identity = await load('process-identity.cjs')
        process.stdout.write(JSON.stringify({ handoff: true, directory: prepared.directory, host: identity.default.inspectProcess(child.pid) }), () => process.exit(0))
      } else child.send({ kind: 'fixture_source_verification', accepted }, () => {})
    })
  }
  ended = once(child, 'close')
  let output = '', error = ''
  child.stdout.on('data', bytes => { output += bytes.toString(); if (output.length > 4096) child.kill('SIGKILL') })
  child.stderr.on('data', bytes => { error = (error + bytes.toString()).slice(-4096) })
  const [code, signal] = await ended
  if (code !== 0 || signal || error) throw new Error('Finite Node host failed: ' + JSON.stringify({ code, signal, output: output.slice(0, 512) }) + ': ' + error)
  const result = JSON.parse(output)
  await fs.rm(prepared.directory, { recursive: true, force: true }); prepared = null
  clearTimeout(timer); process.stdout.write(JSON.stringify(result) + '\n')
})().catch(async error => {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended.catch(() => {}) }
  if (prepared) await fs.rm(prepared.directory, { recursive: true, force: true })
  clearTimeout(timer); console.error(error); process.exitCode = 1
})
