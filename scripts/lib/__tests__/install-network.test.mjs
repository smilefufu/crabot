import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectPackageSource, packageEnvironment, withPackageSource } from '../install-network.mjs'

const silent = { info() {}, warn() {} }
test('available domestic registry is selected once without contacting official', async () => {
  const calls = []
  const source = await selectPackageSource('npm', { logger: silent, probe: async url => { calls.push(url); return true } })
  assert.equal(source.url, 'https://registry.npmmirror.com')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].startsWith(source.url))
})
test('unavailable domestic registry selects official immediately', async () => {
  const source = await selectPackageSource('python', { logger: silent, probe: async () => false })
  assert.equal(source.url, 'https://pypi.org/simple')
})
test('package preparation retries official only once and retains the remaining budget', async () => {
  const source = await selectPackageSource('python', { logger: silent, probe: async () => true })
  const calls = []
  await withPackageSource(source, async (url, env, remaining) => {
    calls.push({ url, remaining })
    if (calls.length === 1) { await new Promise(resolve => setTimeout(resolve, 15)); throw new Error('HTTP 403 Forbidden fetching hatchling index') }
  }, { logger: silent, timeout: 1000 })
  assert.deepEqual(calls.map(c => c.url), ['https://mirrors.aliyun.com/pypi/simple/', 'https://pypi.org/simple'])
  assert.ok(calls[1].remaining < calls[0].remaining)
  assert.equal(source.url, 'https://pypi.org/simple')
})
for (const message of ['Hash mismatch for wheel', 'Cannot find matching keyid', 'EPERM: permission denied', 'ENOSPC: no space', 'compiler exited with code 1', 'unexpected failure']) {
  test(`terminal preparation error does not retry: ${message}`, async () => {
    const source = await selectPackageSource('npm', { logger: silent, probe: async () => true })
    let count = 0
    await assert.rejects(withPackageSource(source, async () => { count++; throw new Error(message) }, { logger: silent }), error => error.message === message)
    assert.equal(count, 1)
  })
}
test('official failure is terminal and retains domestic error context', async () => {
  const source = await selectPackageSource('python', { logger: silent, probe: async () => true })
  let count = 0
  await assert.rejects(withPackageSource(source, async () => { count++; throw new Error('HTTP 403 Forbidden fetching index') }, { logger: silent }), /domestic.*official/is)
  assert.equal(count, 2)
})
test('exhausted budget and cancellation do not start an official attempt', async () => {
  for (const message of ['HTTP 403 Forbidden', 'preparation cancelled']) {
    const source = await selectPackageSource('python', { logger: silent, probe: async () => true })
    let count = 0
    await assert.rejects(withPackageSource(source, async () => {
      count++
      await new Promise(resolve => setTimeout(resolve, 15))
      throw new Error(message)
    }, { logger: silent, timeout: 5 }))
    assert.equal(count, 1)
  }
})
test('public registry settings and credentials stay in a child environment; proxy and CA remain', () => {
  const parent = { PATH: 'tools', HTTPS_PROXY: 'http://localhost:7890', SSL_CERT_FILE: 'company-ca.pem', UV_PYTHON: 'conda-python', COREPACK_NPM_TOKEN: 'secret', COREPACK_INTEGRITY_KEYS: '0', UV_INDEX_URL: 'https://private.example/simple', UV_INSECURE_HOST: 'mirror.example', npm_config_registry: 'https://private.example', npm_config_strict_ssl: 'false' }
  const original = { ...parent }
  const node = packageEnvironment('npm', 'https://registry.npmmirror.com', parent)
  assert.equal(node.npm_config_registry, 'https://registry.npmmirror.com')
  assert.equal(node.COREPACK_NPM_REGISTRY, node.npm_config_registry)
  assert.equal(node.COREPACK_NPM_TOKEN, undefined)
  assert.equal(node.COREPACK_INTEGRITY_KEYS, undefined)
  assert.equal(node.npm_config_strict_ssl, 'true')
  const python = packageEnvironment('python', 'https://mirrors.aliyun.com/pypi/simple/', parent)
  assert.equal(python.UV_INDEX, 'https://mirrors.aliyun.com/pypi/simple/')
  assert.equal(python.UV_INSECURE_HOST, undefined)
  for (const key of ['PATH', 'HTTPS_PROXY', 'SSL_CERT_FILE', 'UV_PYTHON']) assert.equal(python[key], parent[key])
  assert.deepEqual(parent, original)
})

test('private npm config is excluded while proxy and CA are preserved; owned configs are removed', async () => {
  const { mkdtemp, writeFile, readFile, access, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'npm-config-test-'))
  const file = join(root, '.npmrc')
  const certificate = join(root, 'company-ca.pem')
  const config = `_auth=private-secret\nregistry=https://private.invalid\ncafile=${certificate}\nhttps-proxy=http://127.0.0.1:7890\n`
  await writeFile(file, config)
  let owned
  try {
    const source = await selectPackageSource('npm', { probe: async () => true, logger: silent })
    await withPackageSource(source, async (url, env) => {
      assert.notEqual(env.npm_config_userconfig, file)
      assert.equal(await readFile(env.npm_config_userconfig, 'utf8'), '')
      assert.equal(await readFile(env.npm_config_globalconfig, 'utf8'), '')
      assert.equal(env.npm_config_cafile, certificate)
      assert.equal(env.npm_config_https_proxy, 'http://127.0.0.1:7890')
      owned = env.npm_config_userconfig
    }, { env: { ...process.env, npm_config_userconfig: file }, logger: silent })
    await assert.rejects(access(owned))
    assert.equal(await readFile(file, 'utf8'), config)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('uv missing locked version retries official once without changing the requirement', async () => {
  const source = await selectPackageSource('python', { probe: async () => true, logger: silent })
  const requirement = 'hatchling==999999.0.0'
  const calls = []
  await withPackageSource(source, async url => {
    calls.push({ url, requirement })
    if (calls.length === 1) throw new Error(`Because there is no version of ${requirement} and you require ${requirement}, requirements are unsatisfiable`)
  }, { logger: silent })
  assert.deepEqual(calls, [{ url: source.domestic, requirement }, { url: source.official, requirement }])
})

test('Windows environment name casing cannot forward authentication or disable verification', () => {
  const parent = { corepack_npm_token: 'private', corepack_integrity_keys: '0', uv_insecure_host: 'mirrors.aliyun.com', uv_no_verify_hashes: '1', uv_index_private_password: 'private' }
  const npm = packageEnvironment('npm', 'https://registry.npmmirror.com', parent)
  const python = packageEnvironment('python', 'https://mirrors.aliyun.com/pypi/simple/', parent)
  assert.equal(npm.corepack_npm_token, undefined)
  assert.equal(npm.corepack_integrity_keys, undefined)
  assert.equal(python.uv_insecure_host, undefined)
  assert.equal(python.uv_no_verify_hashes, undefined)
  assert.equal(python.uv_index_private_password, undefined)
  assert.equal(parent.corepack_npm_token, 'private')
})

test('Windows curl probes accept a plain environment with lowercase windir', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const root = await mkdtemp(join(tmpdir(), 'crabot-windir-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { 'better-sqlite3': '12.9.0' } }))
  await writeFile(join(root, 'pnpm-lock.yaml'), '  better-sqlite3@12.9.0:\n')
  const code = `
    import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {promisify} from 'node:util';import path from 'node:path';
    Object.defineProperty(process,'platform',{value:'win32'});let calls=0;
    cp.execFile=()=>{};cp.execFile[promisify.custom]=async(command,args)=>{
      if(command!==path.join(process.env.TEST_ROOT,'System32/curl.exe'))throw new Error('incorrect Windows curl path');calls++;
      const url=args.find(arg=>arg.startsWith('https://'));return {stdout:args.includes('--head')?'Content-Type: application/octet-stream\\n'+url:JSON.stringify({version:'0.31.0',dist:{integrity:'fixture',tarball:'fixture'}})+'\\n'+url};
    };syncBuiltinESMExports();
    const {selectPackageSource,nativePackageEnvironment,packageSource,packageEnvironment}=await import(process.env.TEST_MODULE);
    const env={windir:process.env.TEST_ROOT,HTTPS_PROXY:'http://localhost:7890'};
    const source=await selectPackageSource('npm',{env,logger:{info(){}}});if(source.url!==source.domestic)throw new Error('registry probe failed');
    const child=await nativePackageEnvironment(process.env.TEST_ROOT,packageSource('npm',source.domestic),packageEnvironment('npm',source.domestic,env),{info(){},warn(){}});if(!child.npm_config_better_sqlite3_binary_host)throw new Error('binary probe failed');if(calls!==2)throw new Error('both probes must execute');
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, TEST_ROOT: root, TEST_MODULE: new URL('../install-network.mjs', import.meta.url).href } })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('Memory keeps installed/explicit Python and pins only a missing default interpreter', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const root = await mkdtemp(join(tmpdir(), 'crabot-python-request-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'uv.lock'), 'unchanged frozen lock')
  for (const mode of ['installed', 'missing', 'environment', 'pin', 'never', 'configured-never', 'configured-manual', 'configured-offline', 'io']) {
    const code = `
      import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {promisify} from 'node:util';import {EventEmitter} from 'node:events';import fs from 'node:fs';
      const mode=process.env.TEST_MODE;const attempts=[];let probe;let frozen=false;process.env.HTTPS_PROXY='http://localhost:7890';
      delete process.env.UV_PYTHON;delete process.env.UV_PYTHON_DOWNLOADS;
      if(mode==='environment')process.env.UV_PYTHON='3.11';if(mode==='never')process.env.UV_PYTHON_DOWNLOADS='never';
      cp.execFile=()=>{};cp.execFile[promisify.custom]=async(command,args)=>{
        if(args.includes('--show-settings'))return {stdout:'connectivity: '+(mode==='configured-offline'?'Offline':'Online')+', system_certs: false, python_preference: Managed, python_downloads: '+(mode==='never'||mode==='configured-never'?'Never':mode==='configured-manual'?'Manual':'Automatic')+','};
        if(args.includes('pin')){if(mode==='pin')return {stdout:'3.11\\n'};throw Object.assign(new Error('no pin'),{stderr:'No Python version file found; specify a version to create one'});}
        if(args.includes('list')){probe=args[2];return {stdout:JSON.stringify([{key:'cpython-fixture',variant:'default',url:'https://mirrors.ustc.edu.cn/fixture.tar.gz'}])};}
        throw new Error('HTTP 404 Not Found');
      };
      cp.spawn=(command,args,options)=>{
        const child=new EventEmitter();child.stderr=new EventEmitter();setImmediate(()=>{
          if(args[0]==='sync')frozen=args.includes('--offline')&&args.includes('--frozen')&&options.env.UV_OFFLINE==='1';
          if(args[0]==='export')fs.writeFileSync(args[args.indexOf('--output-file')+1],'fixture==1.0 --hash=sha256:fixture');
          if(args[0]==='venv'){attempts.push(args);if(args.includes('--no-python-downloads')&&mode!=='installed'){child.stderr.emit('data',Buffer.from(mode==='io'?'EPERM: permission denied':'No interpreter found'));child.emit('close',1);return;}}
          child.emit('close',0);
        });return child;
      };syncBuiltinESMExports();
      const {prepareMemoryDependencies}=await import(process.env.TEST_MODULE);
      let error;try{await prepareMemoryDependencies(process.env.TEST_ROOT,{uv:'fixture-uv',source:{kind:'python',url:'https://pypi.org/simple',domestic:'https://mirrors.aliyun.com/pypi/simple/',official:'https://pypi.org/simple',systemProxy:false},logger:{info(){},warn(){}}})}catch(e){error=e}
      if(mode==='configured-offline'){if(error||!frozen||attempts.length!==0||probe!==undefined)throw error||new Error('offline preparation did not retain the original frozen path')}
      else if(mode==='never'||mode==='configured-never'||mode==='configured-manual'||mode==='io'){if(!error||attempts.length!==1||probe!==undefined)throw new Error('terminal failure attempted Python download')}
      else if(mode==='installed'){if(error||attempts.length!==1||probe!==undefined||attempts[0].includes('--python'))throw error||new Error('installed interpreter replaced')}
      else{const expected=mode==='missing'?'3.12.12':'3.11';if(error||probe!==expected||attempts.length!==2||attempts[1][attempts[1].indexOf('--python')+1]!==expected)throw error||new Error('probe and downloaded interpreter must retain selected request');if(mode!=='missing'&&attempts[0][attempts[0].indexOf('--python')+1]!==expected)throw new Error('explicit Python ignored on first attempt')}
      if(fs.readFileSync(process.env.TEST_ROOT+'/uv.lock','utf8')!=='unchanged frozen lock')throw new Error('lock changed');
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, TEST_MODE: mode, TEST_ROOT: root, TEST_MODULE: new URL('../memory-deps.mjs', import.meta.url).href } })
    assert.equal(result.status, 0, mode + ': ' + result.stdout + result.stderr)
  }
})


test('offline Python sources do not run network or standalone metadata probes', async () => {
  const { selectPythonDownloadSource } = await import('../install-network.mjs')
  let probes = 0
  const env = { UV_OFFLINE: '1' }
  const source = await selectPackageSource('python', { env, logger: silent, probe: async () => { probes++; throw new Error('unexpected probe') } })
  const standalone = await selectPythonDownloadSource('does-not-exist', '3.12.12', { env, logger: silent })
  assert.equal(probes, 0)
  assert.equal(source.url, source.official)
  assert.equal(standalone.url, standalone.official)
  assert.equal(source.systemProxy, false)
})
