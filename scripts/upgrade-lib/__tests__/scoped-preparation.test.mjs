import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describeScopedPreparation } from '../scoped-preparation.mjs'
let root, home, data
beforeEach(async () => {
  root = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-preflight-')))
  home = path.join(root, 'product'); data = path.join(root, 'data')
  await fs.mkdir(data)
})
afterEach(() => fs.rm(root, { recursive: true, force: true }))
async function module(name, { reads = [], writes = [] }) {
  const directory = path.join(home, 'crabot-' + name)
  await fs.mkdir(path.join(directory, 'upgrade'), { recursive: true })
  await fs.mkdir(path.join(data, name), { recursive: true })
  await fs.writeFile(path.join(data, name, 'SCHEMA_VERSION'), 'v1')
  await fs.writeFile(path.join(directory, 'schema_version'), 'v2')
  await fs.writeFile(path.join(directory, 'upgrade/scope.mjs'), `export const migrationScope=()=>(${JSON.stringify({ reads, writes })})`)
  await fs.writeFile(path.join(directory, 'upgrade/from_v1_to_v2.mjs'), 'throw new Error("preflight must not execute this")')
}
it('read-only preflight describes disjoint shared-switch recovery without creating material or running scripts', async () => {
  await module('one', { writes: ['one/config'] })
  await module('two', { reads: ['two/input'], writes: ['two/output'] })
  const plan = await describeScopedPreparation(home, data)
  expect(plan.modules.map(entry => entry.module_id)).toEqual(['crabot-one', 'crabot-two'])
  expect(plan.shared.status).toBe('not_applicable')
  expect(plan.shared_writes).toEqual([])
  await expect(fs.stat(path.join(data, '.upgrade-migrations'))).rejects.toThrow()
  expect(await fs.readFile(path.join(data, 'one/SCHEMA_VERSION'), 'utf8')).toBe('v1')
})
it.each(['read', 'write'])('read-only preflight rejects a cross-module %s dependency before preparing any backup', async mode => {
  await module('one', { writes: ['one/settings'] })
  await module('two', mode === 'read' ? { reads: ['one/settings/nested'], writes: ['two/output'] } : { writes: ['one/settings/nested'] })
  await expect(describeScopedPreparation(home, data)).rejects.toThrow('interdependent')
  await expect(fs.stat(path.join(data, '.upgrade-migrations'))).rejects.toThrow()
})
it('shared write scope conflicts with module reads are rejected while unrelated Admin inputs remain allowed', async () => {
  await module('one', { reads: ['agent/worker-ledgers/channel%3A%3Agroup.json'], writes: ['one/settings'] })
  await fs.mkdir(path.join(home, 'crabot-agent'), { recursive: true }); await fs.writeFile(path.join(home, 'crabot-agent/shared_request_version'), '1')
  await fs.mkdir(path.join(data, 'agent/worker-ledgers'), { recursive: true })
  await fs.writeFile(path.join(data, 'agent/worker-ledgers/channel%3A%3Agroup.json'), JSON.stringify({ manager_key: 'channel::group', workers: [] }))
  await expect(describeScopedPreparation(home, data)).rejects.toThrow('interdependent')
  await fs.writeFile(path.join(home, 'crabot-one/upgrade/scope.mjs'), "export const migrationScope=()=>({reads:[],writes:['admin/session-configs.json']})")
  const plan = await describeScopedPreparation(home, data)
  expect(plan.shared_writes.sort()).toEqual(['agent/shared-request-upgrade.json', 'agent/worker-ledgers/channel%3A%3Agroup.json'].map(name => path.normalize(name)).sort())
  await expect(fs.stat(path.join(data, 'shared-request-upgrade-v2'))).rejects.toThrow()
})
it('unfinished v1 shared recovery is kept on its original path and refuses a new scoped preparation', async () => {
  await module('one', { writes: ['one/settings'] })
  await fs.mkdir(path.join(home, 'crabot-agent'), { recursive: true }); await fs.writeFile(path.join(home, 'crabot-agent/shared_request_version'), '1')
  await fs.mkdir(path.join(data, 'shared-request-upgrade-v1')); await fs.writeFile(path.join(data, 'shared-request-upgrade-v1/evidence'), 'preserve')
  await expect(describeScopedPreparation(home, data)).rejects.toThrow('Legacy request')
  expect(await fs.readFile(path.join(data, 'shared-request-upgrade-v1/evidence'), 'utf8')).toBe('preserve')
})

it('preflight detects the reverse dependency when an earlier module reads a later write scope', async () => {
  await module('one', { reads: ['two/settings'], writes: ['one/output'] })
  await module('two', { writes: ['two/settings/nested'] })
  await expect(describeScopedPreparation(home, data)).rejects.toThrow('interdependent')
  await expect(fs.stat(path.join(data, '.upgrade-migrations'))).rejects.toThrow()
})
