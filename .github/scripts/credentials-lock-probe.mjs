import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
const repo = fileURLToPath(new URL('../../', import.meta.url))
const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-credential-lock-'))
let writer
try {
  for (const name of ['crabot-admin/dist/credentials.js', 'scripts/lib/process-identity.cjs', 'crabot-native/build/Release/crabot-native.node']) {
    const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(repo, name), target)
  }
  await fs.writeFile(path.join(root, 'crabot-admin/package.json'), '{"type":"commonjs"}')
  const actor = `const path=require('node:path');const root=process.argv[1];const credentials=require(path.join(root,'crabot-admin/dist/credentials.js'));
    credentials.newCredentialsFromPassword('fixture-install-password',{is_temp:false,changed_via:'start'}).then(value=>credentials.writeCredentials(path.join(root,'data/admin'),value)).then(()=>{process.on('message',()=>process.exit(0));process.send({ready:true,mapped:process.report.getReport().sharedObjects.some(name=>name.endsWith('crabot-native.node'))})}).catch(error=>{console.error(error);process.exit(1)})`
  writer = spawn(process.execPath, ['-e', actor, root], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const exited = once(writer, 'exit')
  const ready = await Promise.race([once(writer, 'message'), exited.then(() => { throw new Error('writer exited before credentials were ready') }), new Promise((_, reject) => setTimeout(() => reject(new Error('writer deadline')), 10000).unref())])
  assert.deepEqual(ready[0], { ready: true, mapped: true })
  await fs.rename(path.join(root, 'crabot-native'), path.join(root, 'native-moved'))
  const addon = path.join(root, 'native-moved/build/Release/crabot-native.node')
  let code
  await assert.rejects(fs.unlink(addon), error => { code=error.code; return ['EACCES','EPERM'].includes(code) })
  writer.send('exit'); assert.deepEqual(await exited, [0, null])
  await fs.unlink(addon)
  console.log(JSON.stringify({ actual_credentials_loads_target_addon: true, loaded_addon_directory_can_rename: true, same_process_replacement_rejected: code, finite_writer_exit_releases_addon: true }))
} finally {
  if (writer && writer.exitCode === null) { writer.kill(); await once(writer, 'exit') }
  await fs.rm(root, { recursive: true, force: true })
}
