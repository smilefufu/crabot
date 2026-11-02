import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { runMacLegacyHandoff } from '../dist/mac-legacy-handoff.js'

async function fixture(t, script) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-mac-admission-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const lib = path.join(root, 'scripts/lib'); await fs.mkdir(lib, { recursive: true })
  await fs.writeFile(path.join(lib, 'core-release.mjs'), 'export async function readInstalledCoreRelease() { return {version:"1.2.3"} }')
  await fs.writeFile(path.join(lib, 'product-runtime.cjs'), `module.exports={loadProductRuntime:()=>({executables:{node:${JSON.stringify(process.execPath)}}})}`)
  await fs.writeFile(path.join(lib, 'process-identity.cjs'), `module.exports={inspectProcess:()=>({owner:'fixture',executable:${JSON.stringify(process.execPath)}})}`)
  await fs.writeFile(path.join(root, 'scripts/mac-adopt-legacy.mjs'), script)
  return root
}

test('Mac admission reports progress to its existing main window without creating a separate window', async t => {
  const root = await fixture(t, `process.send({type:'progress',phase:'stopping'});process.send({type:'progress',phase:'converting'});process.send({type:'handoff',result:{dataDir:process.env.DATA_DIR,verification_pending:true,maintenance_id:'fixture'}});process.disconnect()`)
  const progress = [], abort = new AbortController()
  await runMacLegacyHandoff(root, root, root, '1.2.3', { signal: abort.signal, progress: (...args) => progress.push(args) })
  assert.deepEqual(progress, [['正在正常停止旧版服务…', true], ['正在转换已保护的数据范围…', false]])
})

test('Mac admission honors main-window cancellation before data conversion', async t => {
  const root = await fixture(t, `process.on('message',message=>{if(message.type==='cancel'){process.send({type:'failure',code:'ABORT_ERR'});process.exitCode=1;process.disconnect()}});process.send({type:'progress',phase:'stopping'})`)
  const abort = new AbortController()
  await assert.rejects(runMacLegacyHandoff(root, root, root, '1.2.3', {
    signal: abort.signal, progress: () => abort.abort(),
  }), /ABORT_ERR/)
})
