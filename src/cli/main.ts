import { Command } from 'commander'
import { resolveAuth } from './auth.js'
import { AdminClient } from './client.js'
import { registerProviderCommands } from './commands/provider.js'
import { registerAgentCommands } from './commands/agent.js'
import { registerMcpCommands } from './commands/mcp.js'
import { registerSkillCommands } from './commands/skill.js'
import { registerScheduleCommands } from './commands/schedule.js'
import { registerChannelCommands } from './commands/channel.js'
import { registerFriendCommands } from './commands/friend.js'
import { registerConfigCommands } from './commands/config.js'
import { registerPermissionCommands } from './commands/permission.js'

export function createClient(program: Command): { client: AdminClient; json: boolean } {
  const opts = program.opts<{
    endpoint?: string
    token?: string
    json?: boolean
  }>()

  const auth = resolveAuth({
    endpoint: opts.endpoint,
    token: opts.token,
  })

  return {
    client: new AdminClient(auth),
    json: opts.json ?? false,
  }
}

export function run(argv: string[]): void {
  const program = new Command()

  program
    .name('crabot')
    .description('Crabot CLI — Admin REST API client')
    .version('1.0.0')
    .option('-e, --endpoint <url>', 'Admin endpoint URL (overrides CRABOT_ENDPOINT)')
    .option('-t, --token <token>', 'Auth token (overrides CRABOT_TOKEN)')
    .option('--json', 'Output raw JSON')

  registerProviderCommands(program)
  registerAgentCommands(program)
  registerMcpCommands(program)
  registerSkillCommands(program)
  registerScheduleCommands(program)
  registerChannelCommands(program)
  registerFriendCommands(program)
  registerConfigCommands(program)
  registerPermissionCommands(program)

  program.parseAsync(argv).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    process.exit(1)
  })
}
