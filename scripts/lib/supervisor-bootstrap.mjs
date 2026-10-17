// The inherited IPC authorizes only adoption of this exact pre-registered
// controller generation. It grants no human session or business capability.
// Failed claims preserve their exact runtime evidence.
import { readOwnStartingRuntime } from './instance-runtime.mjs'

export async function claimSupervisorStart({ root, dataDir, mmPort }) {
  if (!process.connected || !process.send) throw new Error('Supervisor requires its launching parent connection')
  const frame = await new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer); process.removeListener('message', receive); process.removeListener('disconnect', disconnected)
      if (error) reject(error); else resolve(value)
    }
    const receive = value => finish(null, value)
    const disconnected = () => finish(new Error('Launching parent disconnected before startup was claimed'))
    const timer = setTimeout(() => finish(new Error('Supervisor startup claim timed out')), 10_000)
    process.once('message', receive); process.once('disconnect', disconnected)
    // The parent waits for this before sending; startup imports cannot lose an
    // IPC frame sent before the child installed its message listener.
    process.send({ type: 'crabot-supervisor-awaiting' }, error => { if (error) finish(error) })
  })
  if (!frame || frame.type !== 'crabot-supervisor-start' || typeof frame.generation !== 'string'
    || Object.keys(frame).some(key => !['type', 'generation'].includes(key))) throw new Error('Invalid supervisor startup claim')
  const record = readOwnStartingRuntime({ root, dataDir, mmPort, generation: frame.generation })
  await new Promise((resolve, reject) => process.send({ type: 'crabot-supervisor-claimed', generation: record.generation }, error => error ? reject(error) : resolve()))
  return record
}
