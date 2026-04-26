import { Command } from 'commander'
import { createContext } from '../../main.js'
import { renderResult } from '../../output.js'
import { resolveRef } from '../../resolve.js'
import { runWrite } from '../../run-write.js'

function makeToggleAction(parent: Command, action: 'pause' | 'resume') {
  return async (ref: string) => {
    const ctx = createContext(parent)
    const { id, name } = await resolveRef(ctx.client, 'schedule', ref)
    const targetEnabled = action === 'resume'
    const reverseAction = action === 'pause' ? 'resume' : 'pause'

    const result = await runWrite({
      subcommand: `schedule ${action}`,
      args: { '_positional': ref },
      command_text: `schedule ${action} ${ref}`,
      execute: () => ctx.client.patch(`/api/schedules/${id}`, { enabled: targetEnabled }),
      reverseFromResult: () => ({
        command: `schedule ${reverseAction} ${ref}`,
        preview_description: `${reverseAction} schedule ${name}`,
      }),
      dataDir: ctx.dataDir,
      actor: process.env['CRABOT_ACTOR'] ?? 'human',
    })
    renderResult(result, { mode: ctx.mode })
  }
}

export function registerScheduleToggleCommands(parent: Command): void {
  const scheduleCmd = parent.commands.find(c => c.name() === 'schedule')
  if (!scheduleCmd) throw new Error('schedule command must be registered first')

  scheduleCmd
    .command('pause <ref>')
    .description('Pause a schedule (composite)')
    .action(makeToggleAction(parent, 'pause'))

  scheduleCmd
    .command('resume <ref>')
    .description('Resume a schedule (composite)')
    .action(makeToggleAction(parent, 'resume'))
}
