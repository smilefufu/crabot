import { controlSystemUser, inspectSystemUser } from './system-control.mjs'

// Foreground waiting never owns a lifecycle/control lock; another CLI can stop.
export async function runOwnSystemCommand(entry, action, args) {
  const result = await controlSystemUser(entry, action)
  console.log('[crabot] ' + result.state + ': ' + entry.user)
  if (action !== 'start' || args.includes('-d') || args.includes('--daemon')) return
  console.log('[crabot] Admin Web: http://localhost:' + (3000 + entry.port_offset))
  const initial = await inspectSystemUser(entry)
  if (initial.state !== 'running') return
  let ending = false, failure
  const stop = () => {
    if (ending) return
    ending = true
    void controlSystemUser(entry, 'stop', initial).catch(error => { failure = error })
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    while (!failure) {
      const current = await inspectSystemUser(entry)
      if (current.state === 'stopped' || current.generation !== initial.generation) return
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw failure
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
}
