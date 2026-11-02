import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import binding from '../../scripts/lib/ubuntu-app-binding.cjs'
const require=createRequire(import.meta.url), ts=require('typescript')
const source=readFileSync(new URL('../src/ubuntu-first-launch.ts',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
const exports={};vm.runInNewContext(compiled,{exports,require,Error})
function fixture(t,responses=[0]) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'crabot-deb-first-'))),home=join(root,'home'),coreRoot=join(root,'Crabot/resources/core')
  mkdirSync(coreRoot,{recursive:true});mkdirSync(home)
  writeFileSync(join(coreRoot,'desktop-host.json'),JSON.stringify({schema_version:1,platform:'linux',arch:'x64'}))
  writeFileSync(join(coreRoot,'../package-type'),'deb\n')
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const messages=[],events=[]
  const options={coreRoot,home,env:{},version:'0.1.0',dialog:{
    showMessageBox:async v=>{messages.push(v);return {response:responses.shift()??0}},
    showOpenDialog:async()=>({canceled:true,filePaths:[]})},
    load:async name=> name==='core-release.mjs'?{readInstalledCoreRelease:async()=>({version:'0.1.0'})}:import(new URL('../../scripts/lib/'+name,import.meta.url)),
    onDataSelected:async()=>events.push('main-window'),progress:()=>events.push('progress')}
  return {root,home,coreRoot,options,messages,events}
}
describe('Ubuntu first launch', { skip: process.platform === 'win32' }, () => {
test('fresh DEB has external data, no old CLI adoption and no repeat prompt on reopen',async t=>{
  const f=fixture(t),data=await exports.prepareUbuntuAppData(f.options)
  assert.equal(data,join(f.home,'.local/share/crabot/data'))
  assert.ok(existsSync(join(data,'desktop-managed.json')))
  assert.equal(existsSync(join(f.home,'.crabot/data')),false)
  const count=f.messages.length;assert.equal(await exports.prepareUbuntuAppData(f.options),data);assert.equal(f.messages.length,count)
  assert.equal(f.events[0],'main-window')
})
test('cancel never creates data or a locator',async t=>{
  const f=fixture(t,[2]);assert.equal(await exports.prepareUbuntuAppData(f.options),null)
  assert.equal(existsSync(binding.bindingFile({home:f.home,env:{}})),false)
  assert.equal(existsSync(binding.defaultDataDir({home:f.home,env:{}})),false)
})
test('custom chooser preserves unknown data and rejects initialization as a fresh instance',async t=>{
  const f=fixture(t,[1]),chosen=join(f.root,'.existing');mkdirSync(chosen);writeFileSync(join(chosen,'history'),'retain')
  f.options.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[chosen]})
  await assert.rejects(exports.prepareUbuntuAppData(f.options),{code:'CRABOT_DESKTOP_TAKEOVER_REQUIRED'})
  assert.equal(readFileSync(join(chosen,'history'),'utf8'),'retain')
  assert.equal(existsSync(binding.bindingFile({home:f.home,env:{}})),false)
})
test('legacy data requires explicit consent and conversion finishes before ordinary startup',async t=>{
  const f=fixture(t,[0,0]),oldRoot=join(f.home,'.crabot'),oldData=join(oldRoot,'data');mkdirSync(oldData,{recursive:true})
  writeFileSync(join(oldData,'history'),'retain');writeFileSync(join(oldRoot,'VERSION'),'v2026.10.14.1');writeFileSync(join(oldRoot,'cli.mjs'),'// old release')
  const normalLoad=f.options.load;let imported=0
  f.options.load=async name=> name==='desktop-data-import.mjs'?{
    ...(await normalLoad(name)), importDesktopData:async ({source,target})=>{
      imported++;assert.equal(source.dataRoot,oldData);assert.equal(binding.readUbuntuAppBinding({home:f.home,env:{}}).source_root,oldRoot)
      writeFileSync(join(target,'desktop-managed.json'),JSON.stringify({schema_version:1,install_kind:'desktop',admin_listen_host:'127.0.0.1'}))
    }}:normalLoad(name)
  const data=await exports.prepareUbuntuAppData(f.options);assert.notEqual(data,oldData);assert.equal(imported,1)
  assert.equal(readFileSync(join(oldData,'history'),'utf8'),'retain')
  await exports.prepareUbuntuAppData(f.options);assert.equal(imported,1)
})
test('declining legacy import uses independent data without stopping or modifying source',async t=>{
  const f=fixture(t,[0,1]),oldRoot=join(f.home,'.crabot'),oldData=join(oldRoot,'data');mkdirSync(oldData,{recursive:true});writeFileSync(join(oldData,'history'),'keep')
  const data=await exports.prepareUbuntuAppData(f.options)
  assert.notEqual(data,oldData);assert.equal(readFileSync(join(oldData,'history'),'utf8'),'keep')
  assert.equal(binding.readUbuntuAppBinding({home:f.home,env:{}}).source_root,undefined)
})

test('choosing the old data as its own import target publishes no binding and changes no source data',async t=>{
  const f=fixture(t,[1,0]),oldRoot=join(f.home,'.crabot'),oldData=join(oldRoot,'data');mkdirSync(oldData,{recursive:true})
  writeFileSync(join(oldData,'history'),'keep');writeFileSync(join(oldRoot,'VERSION'),'v2026.10.14.1');writeFileSync(join(oldRoot,'cli.mjs'),'// legacy')
  f.options.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[oldData]})
  await assert.rejects(exports.prepareUbuntuAppData(f.options),/不能重叠/)
  assert.equal(existsSync(binding.bindingFile({home:f.home,env:{}})),false)
  assert.equal(readFileSync(join(oldData,'history'),'utf8'),'keep')
})
})
