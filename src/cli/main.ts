import { Command } from 'commander'
import { resolveAuth } from './auth.js'
import { AdminClient } from './client.js'
import { CliError } from './errors.js'
import { renderError, type OutputMode } from './output.js'
import { registerProviderCommands } from './commands/provider.js'
import { registerAgentCommands } from './commands/agent.js'
import { registerMcpCommands } from './commands/mcp.js'
import { registerSkillCommands } from './commands/skill.js'
import { registerScheduleCommands } from './commands/schedule.js'
import { registerChannelCommands } from './commands/channel.js'
import { registerFriendCommands } from './commands/friend.js'
import { registerConfigCommands } from './commands/config.js'
import { registerPermissionCommands } from './commands/permission.js'

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
  return program.opts<{ endpoint?: string; token?: string; human?: boolean; json?: boolean }>()
}

export function createContext(program: Command): CliContext {
  const opts = readGlobalOpts(program)
  const auth = resolveAuth({ endpoint: opts.endpoint, token: opts.token })
  return {
    client: new AdminClient(auth),
    mode: opts.human ? 'human' : 'ai',
    dataDir: getDataDir(),
  }
}

// Backward-compat for commands not yet migrated to createContext
export function createClient(program: Command): { client: AdminClient; json: boolean } {
  const opts = readGlobalOpts(program)
  const auth = resolveAuth({ endpoint: opts.endpoint, token: opts.token })
  return { client: new AdminClient(auth), json: !opts.human }
}

export function run(argv: string[]): void {
  const program = new Command()

  program
    .name('crabot')
    .description('Crabot CLI — AI-first admin client')
    .version('1.0.0')
    .option('-e, --endpoint <url>', 'Admin endpoint URL (overrides CRABOT_ENDPOINT)')
    .option('-t, --token <token>', 'Auth token (overrides CRABOT_TOKEN)')
    .option('--human', 'Human-readable output (table + colored errors)')
    .option('--json', 'JSON output (default; alias for AI mode)')

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
