import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import native from '../process-identity.cjs'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const windowsOnly = { skip: process.platform !== 'win32' }

// The job must be assigned before the root can create the descendant.
async function attachedRoot(job) {
  const source = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{detached:true,stdio:'ignore'});
    child.unref();process.send(child.pid);setTimeout(()=>process.exit(0),50)`
  const root = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  native.assignProcessToJob(job, root.pid)
  const [descendant] = await once(root, 'message')
  await once(root, 'exit')
  return { root, descendant }
}

test('a job still owns and kills a detached descendant after the root exits', windowsOnly, async t => {
  const job = native.createProcessJob()
  t.after(() => native.closeProcessJob(job))
  const { descendant } = await attachedRoot(job)
  assert.equal(native.inspectProcessJob(job), 1)
  assert.equal(native.isProcessExited(descendant), false)

  native.terminateProcessJob(job)
  // Termination is asynchronous: job accounting and process signaling settle separately.
  const end = Date.now() + 5000
  while ((native.inspectProcessJob(job) !== 0 || !native.isProcessExited(descendant)) && Date.now() < end) await delay(20)
  assert.equal(native.inspectProcessJob(job), 0)
  assert.equal(native.isProcessExited(descendant), true)
})

test('closing the job kills members that outlive the root', windowsOnly, async () => {
  const job = native.createProcessJob()
  const { descendant } = await attachedRoot(job)
  native.closeProcessJob(job)
  const end = Date.now() + 5000
  while (!native.isProcessExited(descendant) && Date.now() < end) await delay(20)
  assert.equal(native.isProcessExited(descendant), true)
})
