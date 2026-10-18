// Fault injection only: Windows libuv normally closes the parent's job and
// kills attached children. Keep exactly this disposable script alive so the
// crash regression can exercise the live-orphan guard on every platform.
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'

export function keepControlledChildAfterParentExit(entry) {
  if (!path.isAbsolute(entry)) throw new Error('A fixed controlled entry is required')
  if (process.platform !== 'win32') return
  const original = childProcess.spawn
  childProcess.spawn = (command, args, options) => {
    if (!args.includes(entry)) return original(command, args, options)
    childProcess.spawn = original
    syncBuiltinESMExports()
    return original(command, args, { ...options, detached: true, windowsHide: true })
  }
  syncBuiltinESMExports()
}
