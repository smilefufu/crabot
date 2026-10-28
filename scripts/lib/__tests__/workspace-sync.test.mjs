import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const syncModule = new URL('../workspace-sync.mjs', import.meta.url).href
function run(root, fail = false, replacement) {
  const code = `import fs from 'node:fs';import{syncWorkspaceDirectoryFd}from ${JSON.stringify(syncModule)};
    const original=fs.fsyncSync, closed=fs.closeSync, observed=[], handles=new Set();let firstFile;
    fs.fsyncSync=fd=>{const st=fs.fstatSync(fd,{bigint:true});observed.push([st.dev.toString(),st.ino.toString(),st.isDirectory()]);
      if(!st.isDirectory()&&firstFile===undefined){firstFile=fd;if(${replacement !== undefined}){fs.renameSync(${JSON.stringify(root)},${JSON.stringify(root + '-retained')});fs.symlinkSync(${JSON.stringify(replacement)},${JSON.stringify(root)},'dir')}};if(${fail}&&!st.isDirectory())throw Object.assign(new Error('finite sync failure'),{code:'EIO'});return original(fd)};
    const open=fs.openSync;fs.openSync=(...args)=>{const fd=open(...args);handles.add(fd);return fd};fs.closeSync=fd=>{closed(fd);handles.delete(fd)};
    const fd=fs.openSync(${JSON.stringify(root)},fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW), stat=fs.fstatSync(fd,{bigint:true});
    let error;try{syncWorkspaceDirectoryFd(fd,{dev:stat.dev.toString(),ino:stat.ino.toString()})}catch(e){error=e.code}
    fs.closeSync(fd);let fileClosed=true;if(firstFile!==undefined)try{fs.fstatSync(firstFile);fileClosed=false}catch{}
    process.stdout.write(JSON.stringify({observed,error,remaining:handles.size,fileClosed}));`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'workspace-sync-'))), tree = path.join(root, 'tree')
  fs.mkdirSync(tree); fs.mkdirSync(path.join(tree, 'nested')); fs.writeFileSync(path.join(tree, 'nested/.file'), 'original bytes', { mode: 0o444 })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, tree }
}

test('pinned POSIX synchronization flushes read-only files and directories after their children without following links', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, 'external canary')
  fs.symlinkSync(outside, path.join(f.tree, 'external-link'))
  const before = fs.lstatSync(path.join(f.tree, 'nested/.file'), { bigint: true }), result = run(f.tree)
  assert.equal(result.error, undefined); assert.equal(result.remaining, 0); assert.equal(result.fileClosed, true)
  const key = file => { const stat = fs.statSync(file, { bigint: true }); return [stat.dev.toString(), stat.ino.toString()] }
  assert.deepEqual(result.observed.map(row => row.slice(0, 2)), [key(path.join(f.tree, 'nested/.file')), key(path.join(f.tree, 'nested')), key(f.tree)])
  assert.equal(fs.readFileSync(outside, 'utf8'), 'external canary')
  for (const property of ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs']) assert.equal(fs.lstatSync(path.join(f.tree, 'nested/.file'), { bigint: true })[property], before[property])
})

test('a real sync error retains all files, closes descriptors and cannot claim readiness', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), result = run(f.tree, true)
  assert.equal(result.error, 'EIO'); assert.equal(result.remaining, 0); assert.equal(result.fileClosed, true)
  assert.equal(result.observed.length, 1)
  assert.equal(fs.readFileSync(path.join(f.tree, 'nested/.file'), 'utf8'), 'original bytes')
})


test('a renamed payload root never redirects descriptor-based synchronization into its path replacement', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'canary'), 'external bytes')
  const stat = fs.statSync(path.join(outside, 'canary'), { bigint: true }), result = run(f.tree, false, outside)
  assert.equal(result.remaining, 0); assert.equal(result.fileClosed, true)
  assert.equal(result.error, 'WORKSPACE_SYNC_UNVERIFIED')
  assert.equal(result.observed.some(row => row[0] === stat.dev.toString() && row[1] === stat.ino.toString()), false)
  assert.equal(fs.readFileSync(path.join(outside, 'canary'), 'utf8'), 'external bytes')
  assert.equal(fs.readFileSync(path.join(f.tree + '-retained', 'nested/.file'), 'utf8'), 'original bytes')
})
