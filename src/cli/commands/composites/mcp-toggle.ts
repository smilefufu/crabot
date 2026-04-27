import { Command } from 'commander'
import { createContext } from '../../main.js'
import { renderResult } from '../../output.js'
import { resolveRef } from '../../resolve.js'
import { runWrite } from '../../run-write.js'
import { CliError } from '../../errors.js'

export function registerMcpToggleCommand(parent: Command): void {
  const mcpCmd = parent.commands.find(c => c.name() === 'mcp')
  if (!mcpCmd) throw new Error('mcp command must be registered first')

  mcpCmd
    .command('toggle <ref>')
    .description('Enable or disable an MCP server (composite)')
    .option('--on', 'Enable')
    .option('--off', 'Disable')
    .action(async (ref: string, opts: { on?: boolean; off?: boolean }) => {
      if (!opts.on && !opts.off) {
        throw new CliError('INVALID_ARGUMENT', 'Specify --on or --off')
      }
      if (opts.on && opts.off) {
        throw new CliError('INVALID_ARGUMENT', 'Cannot specify both --on and --off')
      }
      const ctx = createContext(parent)
      const { id, name } = await resolveRef(ctx.client, 'mcp', ref)
      const targetEnabled = !!opts.on

      const result = await runWrite({
        subcommand: 'mcp toggle',
        args: { '_positional': ref, '--on': opts.on ?? false, '--off': opts.off ?? false },
        command_text: `mcp toggle ${ref} ${opts.on ? '--on' : '--off'}`,
        execute: () => ctx.client.patch(`/api/mcp-servers/${id}`, { enabled: targetEnabled }),
        reverseFromResult: () => ({
          command: `mcp toggle ${ref} ${targetEnabled ? '--off' : '--on'}`,
          preview_description: `${targetEnabled ? 'disable' : 'enable'} mcp ${name}`,
        }),
        dataDir: ctx.dataDir,
        actor: process.env['CRABOT_ACTOR'] ?? 'human',
        mode: ctx.mode,
      })
      renderResult(result, { mode: ctx.mode })
    })
}
