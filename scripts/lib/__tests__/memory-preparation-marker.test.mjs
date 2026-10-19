import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const moduleUrl = new URL('../memory-deps.mjs', import.meta.url).href
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'memory-marker-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'uv.lock'), 'frozen')
  await writeFile(join(root, 'pyproject.toml'), '[project]')
  await writeFile(join(root, 'prepared-environment.json'), 'old-marker-evidence')
  const executable = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  await mkdir(dirname(executable), { recursive: true }); await writeFile(executable, '')
  return root
}
const mock = `
import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {promisify} from 'node:util';import {EventEmitter} from 'node:events';import fs from 'node:fs';
const mode=process.env.TEST_MODE;
const fsp=(await import('node:fs/promises')).default, remove=fsp.rm, rename=fsp.rename;
fsp.rm=(file,...args)=>mode==='clear-failure'&&file.endsWith('prepared-environment.json')?Promise.reject(new Error('fixture marker removal failed')):remove(file,...args);
fsp.rename=(file,target)=>mode==='marker-failure'&&target.endsWith('prepared-environment.json')?Promise.reject(new Error('fixture marker commit failed')):rename(file,target);
cp.execFile=()=>{};cp.execFile[promisify.custom]=async(command,args)=>{
  if(args.includes('--show-settings'))return {stdout:'connectivity: '+(mode==='offline'?'Offline':'Online')+', system_certs: false, python_preference: Managed, python_downloads: Never,'};
  if(args.includes('pin'))throw Object.assign(new Error('no pin'),{stderr:'No Python version file found'});
  throw new Error('unexpected metadata request');
};
cp.spawn=(command,args)=>{const child=new EventEmitter();child.stderr=new EventEmitter();setImmediate(()=>{
  if(args[0]==='export')fs.writeFileSync(args[args.indexOf('--output-file')+1],mode==='fallback'?'-e fixture':'fixture==1.0 --hash=sha256:fixture');
  if(mode==='project-change'&&args[0]==='run')fs.writeFileSync(process.env.TEST_ROOT+'/pyproject.toml','changed');
  if(mode==='lock-change'&&args[0]==='run')fs.writeFileSync(process.env.TEST_ROOT+'/uv.lock','changed');
  if(mode==='failure'&&(args[0]==='venv'||args[0]==='sync')){child.stderr.emit('data',Buffer.from('fixture preparation failed'));child.emit('close',1);return;}
  child.emit('close',0);
});return child;};syncBuiltinESMExports();
const {prepareMemoryDependencies}=await import(process.env.TEST_MODULE);
try{await prepareMemoryDependencies(process.env.TEST_ROOT,{uv:'fixture-uv',relocatable:process.env.TEST_RELOCATABLE==='1',source:{kind:'python',url:'https://pypi.org/simple',domestic:'https://pypi.org/simple',official:'https://pypi.org/simple',systemProxy:false},logger:{info(){},warn(){}}})}
catch(error){console.error(error.message);process.exitCode=1}
`
for (const mode of ['online', 'offline', 'fallback', 'failure', 'lock-change', 'project-change', 'clear-failure']) {
  test(`explicit Memory preparation handles old marker only after success: ${mode}`, async t => {
    const root = await fixture(t)
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', mock], { encoding: 'utf8', env: { ...process.env, TEST_MODULE: moduleUrl, TEST_ROOT: root, TEST_MODE: mode, TEST_RELOCATABLE: '0' } })
    if (['failure', 'lock-change', 'project-change', 'clear-failure'].includes(mode)) {
      assert.notEqual(result.status, 0, result.stdout + result.stderr)
      assert.equal(await readFile(join(root, 'prepared-environment.json'), 'utf8'), 'old-marker-evidence')
    } else {
      assert.equal(result.status, 0, result.stdout + result.stderr)
      await assert.rejects(access(join(root, 'prepared-environment.json')), { code: 'ENOENT' })
      const { preparedMemoryPython } = await import('../memory-deps.mjs')
      assert.equal(await preparedMemoryPython(root), null)
    }
  })
}
for (const mode of ['online', 'failure', 'lock-change', 'project-change', 'marker-failure']) {
  test(`relocatable Memory marker is updated only after verified success: ${mode}`, async t => {
    const root = await fixture(t)
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', mock], { encoding: 'utf8', env: { ...process.env, TEST_MODULE: moduleUrl, TEST_ROOT: root, TEST_MODE: mode, TEST_RELOCATABLE: '1' } })
    const marker = await readFile(join(root, 'prepared-environment.json'), 'utf8')
    if (mode === 'online') {
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.equal(JSON.parse(marker).schema_version, 1)
      const { preparedMemoryPython } = await import('../memory-deps.mjs')
      assert.ok(await preparedMemoryPython(root))
    } else {
      assert.notEqual(result.status, 0, result.stdout + result.stderr)
      assert.equal(marker, 'old-marker-evidence')
    }
  })
}
test('stale marker remains a startup/preflight rejection without explicit preparation', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'prepared-environment.json'), JSON.stringify({ schema_version: 1, platform: process.platform, arch: process.arch, lock_sha256: 'old-lock', project_sha256: 'old-project' }))
  const { preparedMemoryPython } = await import('../memory-deps.mjs')
  await assert.rejects(preparedMemoryPython(root), /stale/)
  assert.match(await readFile(join(root, 'prepared-environment.json'), 'utf8'), /old-lock/)
})
for (const status of [0, 1]) {
  test(`dev Memory sync clears old marker only on success: exit ${status}`, { skip: process.platform === 'win32' }, async t => {
    const root = await fixture(t)
    const dev = await readFile(new URL('../../../dev.sh', import.meta.url), 'utf8')
    const start = dev.indexOf('sync_memory_deps() {'), end = dev.indexOf('\n# ── 停止', start)
    assert.ok(start >= 0 && end > start)
    const code = `set -e\nlog_info(){ :; };log_warn(){ :; };log_dim(){ :; };uv(){ return ${status}; };\n${dev.slice(start, end)}\nsync_memory_deps`
    const result = spawnSync('/bin/bash', ['-c', code], { encoding: 'utf8', env: { ...process.env, SCRIPT_DIR: fileURLToPath(new URL('../../../', import.meta.url)), MEMORY_DIR: root, DATA_DIR: join(root, 'data'), PATH: dirname(process.execPath) + delimiter + process.env.PATH } })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    if (status === 0) await assert.rejects(access(join(root, 'prepared-environment.json')), { code: 'ENOENT' })
    else assert.equal(await readFile(join(root, 'prepared-environment.json'), 'utf8'), 'old-marker-evidence')
  })
}
