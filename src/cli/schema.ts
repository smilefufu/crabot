import type { Command } from 'commander'
import { mustConfirm } from './confirm-rules.js'

export interface SchemaOption {
  readonly flags: string
  readonly description: string
  readonly required: boolean
}

export interface SchemaArg {
  readonly name: string
  readonly required: boolean
}

export interface SchemaCommand {
  readonly name: string
  readonly description: string
  readonly permission: 'read' | 'write'
  readonly must_confirm: boolean
  readonly args: ReadonlyArray<SchemaArg>
  readonly options: ReadonlyArray<SchemaOption>
}

const READ_ACTIONS = new Set(['list', 'show', 'doctor'])

function isReadCommand(parts: string[]): boolean {
  const last = parts[parts.length - 1] ?? ''
  return READ_ACTIONS.has(last)
}

function flatten(cmd: Command, prefix: string[] = []): SchemaCommand[] {
  const out: SchemaCommand[] = []
  const fullName = [...prefix, cmd.name()].filter(p => p && p !== 'crabot').join(' ')
  const subcmds = (cmd as unknown as { commands?: Command[] }).commands
  if (!subcmds || subcmds.length === 0) {
    if (!fullName) return out  // skip the program root itself
    const parts = fullName.split(' ')
    out.push({
      name: fullName,
      description: cmd.description() || '',
      permission: isReadCommand(parts) ? 'read' : 'write',
      must_confirm: mustConfirm(fullName),
      args: ((cmd as unknown as { registeredArguments?: Array<{ _name?: string; name?: () => string; required?: boolean }> }).registeredArguments ?? []).map(a => ({
        name: a._name ?? a.name?.() ?? '',
        required: a.required ?? false,
      })),
      // commander Option：`mandatory` 表示 flag 本身是否必填（requiredOption），
      // `required` 表示"flag 给定时是否必须带值"（<value> vs [value]）。
      // schema 给 LLM 看的"required" 是前者——是否必须传这个 flag。
      options: cmd.options.map(o => ({
        flags: o.flags,
        description: o.description ?? '',
        required: !!(o as unknown as { mandatory?: boolean }).mandatory,
      })),
    })
  } else {
    for (const sub of subcmds) {
      out.push(...flatten(sub, fullName ? [fullName] : []))
    }
  }
  return out
}

export function buildSchema(program: Command, version: string): { version: string; commands: SchemaCommand[] } {
  return { version, commands: flatten(program) }
}
