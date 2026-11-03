import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import binding from '../ubuntu-app-binding.cjs'
function fixture(t) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'crabot-deb-binding-'))), home=join(root,'home'), coreRoot=join(root,'Crabot/resources/core'), dataDir=join(root,'data')
  for(const dir of [home,coreRoot,dataDir])mkdirSync(dir,{recursive:true,mode:0o700})
  writeFileSync(join(coreRoot,'desktop-host.json'),JSON.stringify({schema_version:1,platform:'linux',arch:'x64'}))
  writeFileSync(join(coreRoot,'../package-type'),'deb\n')
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  return {root,home,coreRoot,dataDir,env:{}}
}
describe('Ubuntu data binding', { skip: process.platform === 'win32' }, () => {
test('DEB data binding survives program replacement without a version selector',t=>{
  const f=fixture(t);writeFileSync(join(f.dataDir,'history'),'keep')
  binding.writeUbuntuAppBinding(f)
  assert.equal(binding.readUbuntuAppBinding(f).data_dir,f.dataDir)
  writeFileSync(join(f.coreRoot,'package.json'),'{"version":"2.0.0"}')
  assert.equal(binding.readUbuntuAppBinding(f).core_root,f.coreRoot)
  assert.equal(readFileSync(join(f.dataDir,'history'),'utf8'),'keep')
  assert.equal(existsSync(join(f.dataDir,'resources')),false)
  assert.equal(Object.hasOwn(binding.readUbuntuAppBinding(f),'version'),false)
})
test('XDG defaults are separate from old CLI data and relative XDG paths are ignored',t=>{
  const f=fixture(t)
  assert.equal(binding.defaultDataDir(f),join(f.home,'.local/share/crabot/data'))
  assert.equal(binding.defaultDataDir({...f,env:{XDG_DATA_HOME:join(f.root,'disk')}}),join(f.root,'disk/crabot/data'))
  assert.equal(binding.defaultDataDir({...f,env:{XDG_DATA_HOME:'relative'}}),join(f.home,'.local/share/crabot/data'))
  assert.notEqual(binding.defaultDataDir(f),join(f.home,'.crabot/data'))
})
test('a missing bound directory never creates an empty replacement; unsafe bindings fail',t=>{
  const f=fixture(t);binding.writeUbuntuAppBinding(f);rmSync(f.dataDir,{recursive:true})
  assert.throws(()=>binding.requireUbuntuAppBinding(f),{code:'CRABOT_DATA_MISSING'})
  assert.equal(existsSync(f.dataDir),false)
  chmodSync(binding.bindingFile(f),0o644)
  assert.throws(()=>binding.readUbuntuAppBinding(f),{code:'CRABOT_UBUNTU_APP_BINDING'})
})
test('unknown existing data and in-program storage are never silently adopted',t=>{
  const f=fixture(t)
  assert.throws(()=>binding.writeUbuntuAppBinding({...f,dataDir:join(f.coreRoot,'data')}))
  assert.equal(existsSync(binding.bindingFile(f)),false)
  binding.writeUbuntuAppBinding(f)
  const file=binding.bindingFile(f);rmSync(file);symlinkSync(join(f.root,'foreign'),file)
  assert.throws(()=>binding.readUbuntuAppBinding(f),{code:'CRABOT_UBUNTU_APP_BINDING'})
})
test('an interrupted import retains its source locator, without selecting old program bytes',t=>{
  const f=fixture(t),sourceRoot=join(f.root,'legacy');mkdirSync(sourceRoot)
  binding.writeUbuntuAppBinding({...f,sourceRoot})
  const value=binding.readUbuntuAppBinding(f)
  assert.equal(value.source_root,sourceRoot);assert.equal(value.core_root,f.coreRoot)
})

test('a damaged DEB marker cannot silently fall back to old CLI data',t=>{
  const f=fixture(t);writeFileSync(join(f.coreRoot,'../package-type'),'unexpected')
  assert.throws(()=>binding.ubuntuAppForCore(f.coreRoot),{code:'CRABOT_UBUNTU_APP_BINDING'})
})

test('a dangling package marker and oversized host metadata fail before data binding',t=>{
  const f=fixture(t),marker=join(f.coreRoot,'../package-type');rmSync(marker);symlinkSync(join(f.root,'missing'),marker)
  assert.throws(()=>binding.ubuntuAppForCore(f.coreRoot),{code:'CRABOT_UBUNTU_APP_BINDING'})
  rmSync(marker);writeFileSync(marker,'deb\n');writeFileSync(join(f.coreRoot,'desktop-host.json'),' '.repeat(4097))
  assert.throws(()=>binding.ubuntuAppForCore(f.coreRoot),{code:'CRABOT_UBUNTU_APP_BINDING'})
  assert.equal(existsSync(binding.bindingFile(f)),false)
})

test('invalid directory names cannot publish a binding that is unreadable on the next launch',t=>{
  const f=fixture(t),dataDir=join(f.root,'line\nbreak');mkdirSync(dataDir,{mode:0o700})
  assert.throws(()=>binding.writeUbuntuAppBinding({...f,dataDir}),{code:'CRABOT_UBUNTU_APP_BINDING'})
  assert.equal(existsSync(binding.bindingFile(f)),false)
})

test('Linux CLI uses exactly the GUI data binding and refuses conflicting dev environment', {skip:process.platform!=='linux'},t=>{
  const f=fixture(t);binding.writeUbuntuAppBinding(f)
  writeFileSync(join(f.dataDir,'desktop-managed.json'),JSON.stringify({schema_version:1,install_kind:'desktop',admin_listen_host:'127.0.0.1'}))
  const env={};binding.applyUbuntuAppEnvironment(f.coreRoot,{home:f.home,env})
  assert.equal(env.DATA_DIR,f.dataDir);assert.equal(env.CRABOT_HOME,f.coreRoot)
  assert.throws(()=>binding.applyUbuntuAppEnvironment(f.coreRoot,{home:f.home,env:{CRABOT_DEV:'true'}}),{code:'CRABOT_UBUNTU_APP_BINDING'})
})
})
