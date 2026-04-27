import { Command } from 'commander'
import { resolveAuth } from './auth.js'
import { AdminClient } from './client.js'
import { CliError } from './errors.js'
import { renderError, type OutputMode } from './output.js'
import { buildSchema } from './schema.js'
import { registerProviderCommands } from './commands/provider.js'
import { registerAgentCommands } from './commands/agent.js'
import { registerMcpCommands } from './commands/mcp.js'
import { registerSkillCommands } from './commands/skill.js'
import { registerScheduleCommands } from './commands/schedule.js'
import { registerChannelCommands } from './commands/channel.js'
import { registerFriendCommands } from './commands/friend.js'
import { registerConfigCommands } from './commands/config.js'
import { registerPermissionCommands } from './commands/permission.js'
import { registerAgentSetModelCommand } from './commands/composites/agent-set-model.js'
import { registerAgentDoctorCommand } from './commands/composites/agent-doctor.js'
import { registerConfigSwitchDefaultCommand } from './commands/composites/config-switch-default.js'
import { registerMcpToggleCommand } from './commands/composites/mcp-toggle.js'
import { registerScheduleToggleCommands } from './commands/composites/schedule-toggle.js'
import { registerUndoCommands } from './commands/undo.js'

export interface CliContext {
  readonly client: AdminClient
  readonly mode: OutputMode
  readonly dataDir: string
}

function getDataDir(): string {
  const env = process.env['DATA_DIR']
  if (env) return env
  const offset = Number(process.env['CRABOT_PORT_OFFSET'] ?? 0)
  return offset > 0 ? `data-${offset}` : 'data'
}

function readGlobalOpts(program: Command) {
  return program.opts<{ adminEndpoint?: string; token?: string; human?: boolean; json?: boolean }>()
}

export function createContext(program: Command): CliContext {
  const opts = readGlobalOpts(program)
  const auth = resolveAuth({ endpoint: opts.adminEndpoint, token: opts.token })
  return {
    client: new AdminClient(auth),
    mode: opts.human ? 'human' : 'ai',
    dataDir: getDataDir(),
  }
}

// Backward-compat for commands not yet migrated to createContext
export function createClient(program: Command): { client: AdminClient; json: boolean } {
  const opts = readGlobalOpts(program)
  const auth = resolveAuth({ endpoint: opts.adminEndpoint, token: opts.token })
  return { client: new AdminClient(auth), json: !opts.human }
}

export function run(argv: string[]): void {
  const program = new Command()

  program
    .name('crabot')
    .description('Crabot CLI — AI-first admin client')
    .version('1.0.0')
    .option('-e, --admin-endpoint <url>', 'Admin endpoint URL (overrides CRABOT_ENDPOINT)')
    .option('-t, --token <token>', 'Auth token (overrides CRABOT_TOKEN)')
    .option('--human', 'Human-readable output (table + colored errors)')
    .option('--json', 'JSON output (default; alias for AI mode)')
    .option('--schema', 'Print machine-readable command schema and exit')

  registerProviderCommands(program)
  registerAgentCommands(program)
  registerAgentSetModelCommand(program)
  registerAgentDoctorCommand(program)
  registerMcpCommands(program)
  registerSkillCommands(program)
  registerScheduleCommands(program)
  registerChannelCommands(program)
  registerFriendCommands(program)
  registerConfigCommands(program)
  registerPermissionCommands(program)
  registerConfigSwitchDefaultCommand(program)
  registerMcpToggleCommand(program)
  registerScheduleToggleCommands(program)
  registerUndoCommands(program)

  if (argv.includes('--schema')) {
    process.stdout.write(JSON.stringify(buildSchema(program, '1.0.0'), null, 2) + '\n')
    process.exit(0)
  }

  program.parseAsync(argv).catch((err: unknown) => {
    const cli =
      err instanceof CliError
        ? err
        : new CliError('INTERNAL_ERROR', err instanceof Error ? err.message : String(err))
    const opts = readGlobalOpts(program)
    const mode: OutputMode = opts.human ? 'human' : 'ai'
    renderError(cli, { mode })
    process.exit(cli.exitCode)
  })
}
