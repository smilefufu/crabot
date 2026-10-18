import { systemError } from './system-registry.mjs'
const usage = () => { throw systemError('用法：crabot system status | user add <user> [--autostart] | user remove <user> | start/stop/restart --all [--yes]', 'CRABOT_SYSTEM_ARGUMENTS') }
export function parseSystemArguments(args) {
  const [action, ...rest] = args
  if (action === 'status' && rest.length === 0) return { action }
  if (['start', 'stop', 'restart'].includes(action)) {
    if (!rest.includes('--all') || new Set(rest).size !== rest.length || rest.some(value => !['--all', '--yes'].includes(value))) usage()
    return { action, all: true, yes: rest.includes('--yes') }
  }
  if (action === 'user') {
    const [operation, user, ...flags] = rest
    if (!['add', 'remove'].includes(operation) || !user || user.startsWith('-') || new Set(flags).size !== flags.length
      || flags.some(value => operation !== 'add' || value !== '--autostart')) usage()
    return { action, operation, user, autostart: flags.includes('--autostart') }
  }
  usage()
}
