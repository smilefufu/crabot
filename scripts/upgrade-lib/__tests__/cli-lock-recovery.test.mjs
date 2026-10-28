import { it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { acquireCliLock, releaseCliLock } from '../../lib/cli-lock.mjs'
const helper = pathToFileURL(fileURLToPath(new URL('../../lib/cli-lock.mjs', import.meta.url))).href
let root
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-lock-recovery-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
it('concurrent operations serialize on the persistent native lock despite stale metadata', async () => {
  await fs.writeFile(path.join(root, 'cli.lock'), JSON.stringify({ pid: 2147483000, command: 'dead fixture' }))
  const filename = path.join(root, 'client.mjs')
  await fs.writeFile(filename, `import fs from 'node:fs'; import path from 'node:path';
    const [root,id]=process.argv.slice(2);
    const {acquireCliLock,releaseCliLock}=await import(${JSON.stringify(helper)});
    const lock=await acquireCliLock(root,'client-'+id,3000);
    try{try{fs.writeFileSync(path.join(root,'inside'),id,{flag:'wx'})}catch{fs.writeFileSync(path.join(root,'overlap'),'unsafe');throw new Error('concurrent critical sections')}
      await new Promise(resolve=>setTimeout(resolve,250));fs.unlinkSync(path.join(root,'inside'));
    }finally{releaseCliLock(lock)};`)
  const run = id => new Promise(resolve => {
    const child = spawn(process.execPath, [filename, root, id], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes }); child.on('close', code => resolve({ code, stderr }))
  })
  const results = await Promise.all([run('a'), run('b')])
  expect(results, JSON.stringify(results)).toEqual([{ code: 0, stderr: '' }, { code: 0, stderr: '' }])
  await expect(fs.stat(path.join(root, 'overlap'))).rejects.toThrow()
  expect((await fs.stat(path.join(root, 'cli.lock'))).isFile()).toBe(true)
}, 10000)

it('unlocked stale/corrupt metadata is not authority and unrelated old recovery evidence is retained', async () => {
  const filename = path.join(root, 'cli.lock')
  await fs.mkdir(filename + '.recovery'); await fs.writeFile(path.join(filename + '.recovery', 'evidence'), 'keep')
  for (const bytes of ['corrupt fixture', JSON.stringify({ pid: 2147483000, command: 'dead fixture' })]) {
    await fs.writeFile(filename, bytes)
    const lock = await acquireCliLock(root, 'fixture', 0)
    try { await expect(acquireCliLock(root, 'concurrent fixture', 0)).rejects.toThrow('operation is in progress') }
    finally { releaseCliLock(lock) }
    expect(await fs.readFile(path.join(filename + '.recovery', 'evidence'), 'utf8')).toBe('keep')
  }
})

it('an old exit cleanup cannot remove a lock now owned by another operation', async () => {
  const lock = await acquireCliLock(root, 'first')
  releaseCliLock(lock)
  await fs.writeFile(lock, JSON.stringify({ pid: 2147483000, command: 'later operation' }))
  releaseCliLock(lock)
  expect(JSON.parse(await fs.readFile(lock, 'utf8')).command).toBe('later operation')
})
