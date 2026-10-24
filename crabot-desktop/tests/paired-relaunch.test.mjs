import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { tmpdir } from 'node:os'

async function verifyRelaunch(t, differentBinary) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-pair-relaunch-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const require = createRequire(import.meta.url), identity = require('../../scripts/lib/process-identity.cjs'), electron = require('electron')
  let targetExecutable = ''
  if (differentBinary) {
    const distribution = process.platform === 'darwin' ? path.resolve(path.dirname(electron), '../..') : path.dirname(electron)
    let needed = 512n * 1024n * 1024n
    async function measure(directory) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) await measure(file)
        else if (entry.isFile()) needed += BigInt((await fs.stat(file)).size)
      }
    }
    await measure(distribution)
    const space = await fs.statfs(root, { bigint: true }); assert.ok(space.bavail * space.bsize > needed, 'Separate GUI fixture needs bounded program-copy space')
    const copied = path.join(root, process.platform === 'darwin' ? 'different GUI/Electron.app' : 'different GUI')
    await fs.cp(distribution, copied, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
    targetExecutable = path.join(copied, path.relative(distribution, electron))
  }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [fileURLToPath(new URL('./paired-relaunch.cjs', import.meta.url)), root, 'source', '', targetExecutable],
      { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
    let output = ''
    child.stdout.on('data', bytes => { output = (output + bytes).slice(-32_768) })
    child.stderr.on('data', bytes => { output = (output + bytes).slice(-32_768) })
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output }))
  })
  assert.equal(result.code, 0, result.output)
  let evidence
  const deadline = Date.now() + 25_000
  while (!evidence && Date.now() < deadline) {
    try { evidence = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  assert.deepEqual(evidence, { previous_exited: true, target_single_instance_lock: true, ordinary_stop_calls: 0,
    business_mm_started: false, different_gui_binary: differentBinary }, result.output)
  const target = JSON.parse(await fs.readFile(path.join(root, 'target-process.json'), 'utf8')), exitDeadline = Date.now() + 5000
  while (identity.sameProcess(target, identity.inspectProcess(target.pid)) && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(identity.sameProcess(target, identity.inspectProcess(target.pid)), false, 'Target fixture must exit before its program cache is removed')
  console.log('CRABOT_PAIR_RELAUNCH ' + JSON.stringify(evidence))
}

test('actual Electron relaunch waits for the source exit and reacquires its private single-instance lock', { timeout: 45_000 }, t => verifyRelaunch(t, false))
test('actual Electron handoff starts a separate GUI executable after the old GUI exits', { timeout: 60_000 }, t => verifyRelaunch(t, true))
