// Fixed standalone Node role. No arbitrary module/command input is accepted.
import { admitLegacyMacData } from './lib/mac-legacy-admission.mjs'
const sourceRoot = process.argv[2], abort = new AbortController()
if (!sourceRoot || process.argv.length !== 3) throw new Error('Expected the original release root')
let critical = false
process.on('message', message => { if (message?.type === 'cancel' && !critical) abort.abort() })
process.once('disconnect', () => { if (!critical) abort.abort() })
try {
  const result = await admitLegacyMacData({ sourceRoot, signal: abort.signal, progress: phase => {
    if (phase === 'switching' || phase === 'converting') critical = true
    if (process.connected) process.send({ type: 'progress', phase }, () => {})
  } })
  if (process.connected) process.send({ type: 'handoff', result }, () => process.disconnect())
} catch (error) {
  const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(error.code) ? error.code : 'CRABOT_MAINTENANCE_PENDING'
  process.exitCode = 1
  if (process.connected) process.send({ type: 'failure', code }, () => process.disconnect())
}
