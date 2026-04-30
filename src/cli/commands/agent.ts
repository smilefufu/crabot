import { Command } from 'commander'
import { createContext } from '../main.js'
import { renderResult, type Column, shortId } from '../output.js'
import { resolveRef } from '../resolve.js'
import { maskSensitive } from '../mask.js'
import { runWrite } from '../run-write.js'
import { parseKeyValuePairs } from './_utils.js'

/**
 * Crabot 架构里 Front Handler / Worker Handler 都跑在同一个 `crabot-agent` 模块进程里
 * （`agent list` 看到的 instances 是 module 内的 role/配置，不是独立进程）。admin REST 只
 * 暴露 module-level restart，所以 `agent restart` 没有 per-instance 语义——直接重启整个 module。
 */
const AGENT_MODULE_ID = 'crabot-agent'

const COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v ?? '')) },
  { key: 'name', header: 'NAME' },
  { key: 'role', header: 'ROLE' },
]

export function registerAgentCommands(parent: Command): void {
  const agent = parent.command('agent').description('Manage agent instances')

  agent
    .command('list')
    .description('List all agent instances')
    .action(async () => {
      const ctx = createContext(parent)
      const data = await ctx.client.get<unknown>('/api/agent-instances')
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  agent
    .command('show <ref>')
    .description('Show an agent instance')
    .action(async (ref: string) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'agent', ref)
      const data = await ctx.client.get<unknown>(`/api/agent-instances/${id}`)
      renderResult(maskSensitive(data), { mode: ctx.mode, columns: COLUMNS })
    })

  agent
    .command('config <ref>')
    .description('Get or set agent instance config')
    .option('--set <pairs...>', 'Set config values (key=value, supports dot notation)')
    .action(async (ref: string, opts: { set?: string[] }) => {
      const ctx = createContext(parent)
      const { id } = await resolveRef(ctx.client, 'agent', ref)

      if (opts.set && opts.set.length > 0) {
        const body = parseKeyValuePairs(opts.set)
        // admin GET 返回 { config: ... }（wrap）；PATCH 接受 flat。snapshot 必须存 unwrap 后的形态，
        // 否则 undo --restore-snapshot 时 PATCH body 是 {config:{...}}，admin 读不到字段。
        const before = await ctx.client.getUnwrap<Record<string, unknown>>(`/api/agent-instances/${id}/config`, 'config')
        const result = await runWrite({
          subcommand: 'agent config',
          args: { '_positional': ref, '--set': opts.set.join(' ') },
          command_text: `agent config ${ref} --set ${opts.set.join(' ')}`,
          execute: () => ctx.client.patch(`/api/agent-instances/${id}/config`, body),
          reverse: {
            command: `agent config ${ref} --restore-snapshot`,
            preview_description: `restore agent ${ref} config to snapshot taken before this change`,
          },
          snapshot: before,
          dataDir: ctx.dataDir,
          actor: ctx.actor,
          mode: ctx.mode,
        })
        renderResult(maskSensitive(result), { mode: ctx.mode })
      } else {
        const data = await ctx.client.get<unknown>(`/api/agent-instances/${id}/config`)
        renderResult(maskSensitive(data), { mode: ctx.mode })
      }
    })

  agent
    .command('restart')
    .description(`Restart the ${AGENT_MODULE_ID} module（同时重启所有 agent instance，因为它们共用同一个进程）`)
    .action(async () => {
      const ctx = createContext(parent)
      const data = await ctx.client.post<unknown>(`/api/modules/${AGENT_MODULE_ID}/restart`)
      renderResult(data, { mode: ctx.mode })
    })
}
