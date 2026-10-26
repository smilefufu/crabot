// Finite source-image fixture, not Electron or the product uninstall entry.
// It proves real parent/child and IPC/locks with inert program/data fixtures.
const fs = require('node:fs/promises'), path = require('node:path')
const { pathToFileURL } = require('node:url'), { spawn } = require('node:child_process'), { once } = require('node:events')
const cfg = JSON.parse(process.env.CRABOT_NODE_REMOVAL_FIXTURE)
const load = name => import(pathToFileURL(path.join(cfg.own.guiRoot, 'resources/crabot-maintenance-backend/bootstrap/scripts/lib', name)))
const timer = setTimeout(() => process.exit(2), 45000)
let prepared, child, ended
void (async () => {
  const { prepareDesktopRemovalNode, prepareExistingDesktopRemovalNode } = await load('desktop-removal-host.mjs')
  if (cfg.mode.startsWith('node-job-resume')) {
    const { captureDesktopRemovalProof } = await load('desktop-removal-proof.mjs'), { privateJson } = await load('desktop-preparation-files.mjs')
    const proof = await captureDesktopRemovalProof(cfg.own.root, cfg.operationId), text = JSON.stringify(proof) + '\n'
    await fs.mkdir(path.join(cfg.own.root, 'app/removals', cfg.operationId), { recursive: true, mode: 0o700 })
    await privateJson(path.join(cfg.own.root, 'app/removals', cfg.operationId, 'proof.json'), proof)
    await privateJson(path.join(cfg.own.root, '.desktop-removal.json'), { schema_version: 1, installation_id: cfg.own.record.installation_id,
      operation_id: cfg.operationId, source_selection: cfg.own.selection, phase: 'stopping', proof_sha256: require('node:crypto').createHash('sha256').update(text).digest('hex') })
  }
  prepared = await (cfg.mode.startsWith('node-job-resume') ? prepareExistingDesktopRemovalNode : prepareDesktopRemovalNode)({ installRoot: cfg.own.root, operationId: cfg.operationId })
  if (cfg.mode === 'node-job-copy-changed') await fs.appendFile(path.join(prepared.directory, 'backend/progress.mjs'), '\n// changed fixture bytes\n')
  if (cfg.mode === 'node-job-full-host') {
    if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable CI only')
    const argument = '--crabot-removal-host=' + Buffer.from(JSON.stringify({ installRoot: cfg.own.root, operationId: cfg.operationId, existing: false })).toString('base64url')
    child = spawn(prepared.executable, [path.join(prepared.directory, 'backend/main.mjs'), argument], { cwd: prepared.directory,
      env: { PATH: '', LANG: 'C.UTF-8', GITHUB_ACTIONS: 'true', CRABOT_NODE_REMOVAL_TEST_RESULT: cfg.resultFile }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    ended = once(child, 'close')
    const { createDesktopRemovalNodeSourceExitVerifier } = await load('desktop-removal-source.mjs')
    const verifier = createDesktopRemovalNodeSourceExitVerifier({ installRoot: cfg.own.root, prepared, child })
    child.on('message', message => { if (message?.kind === 'desktop_removal_source_exit') void verifier(message).then(async accepted => {
      if (!accepted) throw new Error('Fixed host source exit rejected')
      const { default: identity } = await load('process-identity.cjs')
      process.stdout.write(JSON.stringify({ handoff: true, directory: prepared.directory, host: identity.inspectProcess(child.pid) }), () => process.exit(0))
    }).catch(error => { console.error(error.message) }) })
    let diagnostic = ''; child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-2048) })
    const [code] = await ended
    throw new Error('Fixed host did not request verified source exit: ' + code + ':' + diagnostic)
  }
  const script = `
    const timer=setTimeout(()=>process.exit(2),30000),parentLost=()=>process.exit(2);process.once('disconnect',parentLost);
    const {pathToFileURL}=await import('node:url'),path=await import('node:path'),{createRequire}=await import('node:module');
    const require=createRequire(pathToFileURL(path.join(process.cwd(),'backend/probe.cjs')));
    const identity=require('./bootstrap/scripts/lib/process-identity.cjs'),entry=require('./bootstrap/scripts/lib/desktop-entry.cjs');
    const installation=require('./bootstrap/scripts/lib/desktop-installation.cjs');
    let lease,ruleAttempts=0,platformFailure;
    const stage=name=>require('node:fs').writeFileSync(process.argv[4]+'.stage',JSON.stringify({stage:name}));
    const probe=message=>new Promise((resolve,reject)=>{process.once('message',value=>value?.kind==='fixture_source_verification'?resolve(value.accepted):reject(new Error('bad fixture reply')));process.send(message,error=>{if(error)reject(error)})});
    try {
      const original=installation.readDesktopInstallation(process.argv[1]),reference=installation.readDesktopPairReference(original.root);
      const ordinaryPeer=entry.verifyDesktopEntry(identity.inspectProcess(process.pid),{executable:path.join(original.root,'app/releases',reference.selection.gui_id,'crabot-desktop'),development:false});
      const {beginInitialDesktopRemovalNode,resumeDesktopRemovalNode}=await import(pathToFileURL(path.join(process.cwd(),'backend/bootstrap/scripts/lib/desktop-removal-job.mjs')));
      const fs=await import('node:fs/promises'),assert=(await import('node:assert/strict')).default;
      const platformMode=['node-job-source-remove','node-job-source-platform-cancel'].includes(process.argv[3]);
      let preparePlatformRemoval;
      if(platformMode){
        assert.equal(process.env.GITHUB_ACTIONS,'true','Privileged actor is disposable-CI only');
        // Only this finite CI actor substitutes noninteractive sudo for Polkit.
        // The copied native helper, job, kernel-state reads and IPC are actual.
        const childProcess=require('node:child_process'),launch=childProcess.spawn;
        childProcess.spawn=(command,args,options)=>{
          assert.equal(command,'/usr/bin/pkexec');assert.equal(args[0],path.join(process.cwd(),'crabot-sandbox-helper'));
          return launch('/usr/bin/sudo',['-n','/usr/bin/env','PKEXEC_UID='+process.getuid(),...args],options);
        };
        (await import('node:module')).syncBuiltinESMExports();
        const {prepareUbuntuRemovalRules}=await import(pathToFileURL(path.join(process.cwd(),'backend/rules.mjs')));
        preparePlatformRemoval=async()=>{
          stage('system-prepare');
          let platform;
          try{platform=await prepareUbuntuRemovalRules({installRoot:process.argv[1],operationId:process.argv[2],signal:new AbortController().signal})}
          catch(error){platformFailure=error;throw error}
          stage('system-ready');
          if(process.argv[3]==='node-job-source-platform-cancel'){await platform.close();throw Object.assign(new Error('finite authorization cancelled'),{code:'FIXTURE_PLATFORM_CANCEL'})}
          return {remove:async()=>{
            ruleAttempts++;assert.equal((await lease.current()).phase,'removing');
            assert.equal((await fs.stat(path.join(process.argv[1],'app/releases',(await lease.current()).source_selection.gui_id,'crabot-desktop'))).isFile(),true);
            if(ruleAttempts===1)throw Object.assign(new Error('finite system cleanup interrupted'),{code:'FIXTURE_PLATFORM_CLEANUP'});
            await platform.remove();
          },close:()=>platform.close()};
        };
      }
      lease=await(process.argv[3].startsWith('node-job-resume')?resumeDesktopRemovalNode:beginInitialDesktopRemovalNode)({installRoot:process.argv[1],operationId:process.argv[2],...(preparePlatformRemoval?{preparePlatformRemoval}:{})});
      const published=await lease.current(),message={kind:'desktop_removal_source_exit',installation_id:published.installation_id,operation_id:published.operation_id,source_selection:published.source_selection};
      let sourceVerifier;
      if(process.argv[3]==='node-job-source-verifier')sourceVerifier={preparing_rejected:await probe(message)===false};
      stage('stopping');await lease.stop();const stopped=await lease.current();
      let sourceExited;
      if(['node-job-resume-source-exit','node-job-source-exit','node-job-source-remove','node-job-source-platform-cancel'].includes(process.argv[3])){stage('source-exit');process.removeListener('disconnect',parentLost);sourceExited=(await lease.exitSource()).source_exited}
      if(sourceVerifier){
        sourceVerifier.wrong_operation_rejected=await probe({...message,operation_id:'00000000-0000-4000-8000-000000000000'})===false;
        sourceVerifier.verified_after_stop=await probe(message)===true;
        const fs=await import('node:fs/promises'),file=path.join(process.cwd(),'backend/progress.mjs'),bytes=await fs.readFile(file);
        await fs.appendFile(file,'\\n// changed fixture copy\\n');sourceVerifier.changed_copy_rejected=await probe(message)===false;await fs.writeFile(file,bytes);
      }
      let programsRemoved=false,platformCancelled=false;
      if(process.argv[3]==='node-job-source-platform-cancel'){
        stage('cancelled-preparation-test');await assert.rejects(lease.removePrograms(),{code:'FIXTURE_PLATFORM_CANCEL'});assert.equal((await lease.current()).phase,'stopping');platformCancelled=true;
      }
      if(process.argv[3]==='node-job-source-remove'){
        stage('program-removal-test');await assert.rejects(lease.removePrograms(),{code:'FIXTURE_PLATFORM_CLEANUP'});
        assert.equal((await lease.current()).phase,'removing');
        const result=await lease.retryRemovePrograms();assert.equal(result.retained.length,0);assert.equal(ruleAttempts,2);
        const {finishDesktopRemoval}=await import(pathToFileURL(path.join(process.cwd(),'backend/bootstrap/scripts/lib/desktop-removal-job.mjs')));
        assert.equal((await finishDesktopRemoval({installRoot:process.argv[1],operationId:process.argv[2]})).phase,'completed');programsRemoved=true;
      }else await lease.cancel();
      lease.close();lease=null;
      const locks=await import(pathToFileURL(path.join(process.cwd(),'backend/bootstrap/scripts/lib/cli-lock.mjs')));
      const rootLock=await locks.acquireExistingCliLock(process.argv[1],'fixture-reacquire',0);
      try{const dataLock=await locks.acquireExistingCliLock(path.join(process.argv[1],'data'),'fixture-reacquire',0);locks.releaseCliLock(dataLock)}finally{locks.releaseCliLock(rootLock)}
      const result={accepted:true,published:published.phase,stopped:stopped.phase,cancelled:!programsRemoved,ordinary_peer:ordinaryPeer,locks_reacquired:true,...(programsRemoved?{programs_removed:true,platform_cleanup_attempts:ruleAttempts,completed:true}:{}),...(platformCancelled?{platform_cancelled:true}:{}),...(sourceVerifier?{source_verifier:sourceVerifier}:{}),...(sourceExited?{source_exited:sourceExited}:{})};
      if(['node-job-resume-source-exit','node-job-source-exit','node-job-source-remove','node-job-source-platform-cancel'].includes(process.argv[3]))await(await import('node:fs/promises')).writeFile(process.argv[4],JSON.stringify(result));
      else process.stdout.write(JSON.stringify(result)+'\\n');
    } catch(error) {
      if(lease)lease.close();
      const result={accepted:false,code:error.code||'FIXTURE_UNEXPECTED'};
      if(['node-job-resume-source-exit','node-job-source-exit','node-job-source-remove','node-job-source-platform-cancel'].includes(process.argv[3]))await(await import('node:fs/promises')).writeFile(process.argv[4],JSON.stringify({...result,message:String(error.message).slice(0,512),stage:(platformFailure||error).stage,cause_code:platformFailure?.code,cause_message:platformFailure?.message,stack:String(error.stack).slice(0,2048)}));
      else process.stdout.write(JSON.stringify(result)+'\\n');
    }
    clearTimeout(timer);process.removeListener('disconnect',parentLost);if(process.connected)process.disconnect();
  `
  const root = cfg.otherRoot || cfg.own.root
  child = spawn(prepared.executable, ['--input-type=module', '--eval', script, root, cfg.operationId, cfg.mode, cfg.resultFile], {
    cwd: prepared.directory, env: { PATH: '', LANG: 'C.UTF-8', ...(process.env.GITHUB_ACTIONS==='true'?{GITHUB_ACTIONS:'true'}:{}) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  if (['node-job-source-verifier', 'node-job-resume-source-exit', 'node-job-source-exit', 'node-job-source-remove', 'node-job-source-platform-cancel'].includes(cfg.mode)) {
    const verifier = load('desktop-removal-source.mjs').then(module => (cfg.mode.startsWith('node-job-resume') ? module.createExistingRemovalNodeSourceExitVerifier : module.createDesktopRemovalNodeSourceExitVerifier)({ installRoot: cfg.own.root, prepared, child }))
    child.on('message', async message => {
      const accepted = await (await verifier)(message)
      if (['node-job-resume-source-exit', 'node-job-source-exit', 'node-job-source-remove', 'node-job-source-platform-cancel'].includes(cfg.mode)) {
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
