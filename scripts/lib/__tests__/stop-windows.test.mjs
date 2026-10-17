import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

test('stop CLI delegates to the shared controller and preserves a failure exit without removing evidence', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'crabot-stop-adapter-'))
  try {
    await fs.mkdir(join(root, 'lib'))
    await fs.writeFile(join(root, '_preflight.mjs'), '')
    await fs.copyFile(new URL('../../stop.mjs', import.meta.url), join(root, 'stop.mjs'))
    await fs.writeFile(join(root, 'lib/instance.mjs'), 'export const resolveCliDataDir=()=>process.env.DATA_DIR')
    await fs.writeFile(join(root, 'lib/cli-lock.mjs'), `import fs from 'node:fs';export const hasInheritedCliLock=()=>false;export const acquireCliLock=async()=>{fs.writeFileSync(process.env.DATA_DIR+'/locked','yes');return 'owned'};export const releaseCliLock=lock=>{if(lock==='owned')fs.writeFileSync(process.env.DATA_DIR+'/released','yes')}`)
    await fs.writeFile(join(root, 'lib/instance-controller.mjs'), `import fs from 'node:fs';export async function stopInstance(data){fs.writeFileSync(data+'/target',data);throw new Error('stop result unknown; evidence retained')}`)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, 'stop.mjs')], { env: { ...process.env, DATA_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
      child.on('error', reject); child.on('exit', code => resolve({ code, output }))
    })
    assert.equal(result.code, 1)
    assert.match(result.output, /stop result unknown/)
    assert.equal(await fs.readFile(join(root, 'target'), 'utf8'), root)
    assert.equal(await fs.readFile(join(root, 'released'), 'utf8'), 'yes')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
