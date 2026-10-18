import { systemError } from './system-registry.mjs'
const usage = () => { throw systemError('用法：crabot system status | user add <user> [--autostart | --no-autostart] | user remove <user> | start/stop/restart --all [--yes] | recover <job-id> [--continue | --cancel] [--yes]', 'CRABOT_SYSTEM_ARGUMENTS') }
export function parseSystemArguments(args) {
  const [action, ...rest] = args
  if (action === 'status' && rest.length === 0) return { action }
  if (['start', 'stop', 'restart'].includes(action)) {
    if (!rest.includes('--all') || new Set(rest).size !== rest.length || rest.some(value => !['--all', '--yes'].includes(value))) usage()
    return { action, all: true, yes: rest.includes('--yes') }
  }
  if (action === 'recover') {
    const [id, ...flags] = rest
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id ?? '') || new Set(flags).size !== flags.length
      || flags.some(value => !['--continue', '--cancel', '--yes'].includes(value))
      || flags.includes('--continue') && flags.includes('--cancel')
      || flags.includes('--yes') && !flags.some(value => ['--continue', '--cancel'].includes(value))) usage()
    return { action, id, mode: flags.includes('--continue') ? 'continue' : flags.includes('--cancel') ? 'cancel' : undefined, yes: flags.includes('--yes') }
  }
  if (action === 'user') {
    const [operation, user, ...flags] = rest
    if (!['add', 'remove'].includes(operation) || !user || user.startsWith('-') || new Set(flags).size !== flags.length
      || flags.some(value => operation !== 'add' || !['--autostart', '--no-autostart'].includes(value)) || flags.length > 1) usage()
    return { action, operation, user, autostart: flags.length ? flags[0] === '--autostart' : undefined }
  }
  usage()
}
