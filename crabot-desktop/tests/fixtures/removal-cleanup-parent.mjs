// Finite Node image parent for the Windows kernel-exit fixture, never a GUI.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
const child = spawn(process.argv[2], [], { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
let output = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', text => {
  output += text
  if (output.includes('\n')) assert.equal(output, 'READY\n', 'Unexpected native readiness bytes: ' + Buffer.from(output).toString('hex'))
  if (output === 'READY\n') {
    process.stdout.write('CHILD:' + child.pid + '\nREADY\n')
    process.stdin.once('data', bytes => { assert.equal(bytes.toString(), 'q'); process.exit(0) })
  }
})
child.once('error', error => { throw error })
child.once('exit', () => process.exit(2))
