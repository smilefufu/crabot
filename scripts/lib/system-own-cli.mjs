import { controlSystemUser, inspectSystemUser } from './system-control.mjs'

// Foreground waiting never owns a lifecycle/control lock; another CLI can stop.
export async function runOwnSystemCommand(entry, action, args, { control = controlSystemUser, observe = inspectSystemUser,
  signals = process, log = console.log } = {}) {
  const foreground = action === 'start' && !args.includes('-d') && !args.includes('--daemon')
  const controller = new AbortController()
  let initial, ending = false, stopPromise
  const stop = () => {
    ending = true; controller.abort()
    if (initial && !stopPromise) {
      stopPromise = control(entry, 'stop', initial)
      void stopPromise.catch(() => {})
    }
  }
  if (foreground) { signals.on('SIGINT', stop); signals.on('SIGTERM', stop) }
  try {
    let result
    try { result = await control(entry, action, undefined, { signal: controller.signal }) }
    catch (error) {
      if (!foreground || !ending) throw error
      initial = await observe(entry)
      if (initial.state !== 'stopped') { stop(); await stopPromise }
      if (error.code !== 'CRABOT_SYSTEM_START_CANCELLED') throw error
      return
    }
    log('[crabot] ' + result.state + ': ' + entry.user)
    if (!foreground) return
    log('[crabot] Admin Web: http://localhost:' + (3000 + entry.port_offset))
    initial = await observe(entry)
    if (ending && initial.state !== 'stopped') { stop(); await stopPromise; return }
    if (initial.state !== 'running') return
    for (;;) {
      if (ending) { await stopPromise; return }
      const current = await observe(entry)
      if (ending) { await stopPromise; return }
      if (current.state === 'stopped' || current.generation !== initial.generation) return
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } finally {
    if (foreground) { signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop) }
  }
}
