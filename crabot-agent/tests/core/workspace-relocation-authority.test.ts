import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256CanonicalJson } from 'crabot-shared'
import { verifyWorkspaceRelocationAuthority } from '../../src/core/workspace-relocation-authority.js'
import { relocationMmFixture as fixture } from './fixtures/relocation-mm.js'

describe('Agent consumes only its private job proof from the actual MM connection', () => {
  it('uses one native-bound connection, the correct source and header-only bearer without writing job data', async () => {
    const f = await fixture()
    try {
      const before = await fs.readFile(path.join(f.data, 'workspace-control/relocation-active/relocation.json'))
      expect(await verifyWorkspaceRelocationAuthority(f.options)).toEqual({ verified: true, ...f.options.params,
        intent_sha256: sha256CanonicalJson(f.intent), launch_sha256: sha256CanonicalJson(f.launch) })
      expect(f.calls).toHaveLength(1); expect(f.calls[0].header_present).toBe(true)
      expect(f.calls[0].body.source).toBe('crabot-agent')
      expect(JSON.stringify(f.calls)).not.toContain(f.options.bearer)
      expect(f.sockets.size).toBe(1)
      expect(await fs.readFile(path.join(f.data, 'workspace-control/relocation-active/relocation.json'))).toEqual(before)
      await expect(fs.stat(path.join(f.root, 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.cleanup() }
  }, 30000)
  it('refuses missing credentials before inspecting a missing data root or connecting', async () => {
    const f = await fixture()
    try {
      await expect(verifyWorkspaceRelocationAuthority({ ...f.options, dataDir: path.join(f.root, 'absent'), bearer: undefined })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(f.calls).toEqual([])
    } finally { await f.cleanup() }
  }, 30000)
  it('rejects a wrong fixed job and malformed params before forwarding credentials', async () => {
    const f = await fixture()
    try {
      await expect(verifyWorkspaceRelocationAuthority({ ...f.options, params: { ...f.options.params, intent_id: randomUUID() } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(verifyWorkspaceRelocationAuthority({ ...f.options, params: { ...f.options.params, action: 'move_files' } as any })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
      expect(f.calls).toEqual([])
    } finally { await f.cleanup() }
  }, 30000)
  it('refuses a coherent private record with the wrong MM creation identity before sending any bearer', async () => {
    const f = await fixture()
    try {
      const control = path.join(f.data, 'workspace-control/relocation-active'), launch = { ...f.launch, parent: { ...f.launch.parent, started: 'wrong-generation' } }
      const readyFile = path.join(control, 'relocation-coordinator-ready.json'), ready = JSON.parse(await fs.readFile(readyFile, 'utf8'))
      await fs.writeFile(path.join(control, 'relocation-coordinator.json'), JSON.stringify(launch))
      await fs.writeFile(readyFile, JSON.stringify({ ...ready, launch_sha256: sha256CanonicalJson(launch) }))
      await expect(verifyWorkspaceRelocationAuthority(f.options)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.calls).toEqual([])
    } finally { await f.cleanup() }
  }, 30000)
  for (const mode of ['hash', 'extra', 'false', 'disconnect', 'mutate']) it(`does not treat an unverified response as authority: ${mode}`, async () => {
    const f = await fixture(mode)
    try {
      await expect(verifyWorkspaceRelocationAuthority(f.options)).rejects.toMatchObject({ code: mode === 'hash' ? 'FORBIDDEN' : 'SERVICE_UNAVAILABLE' })
      expect(f.calls).toHaveLength(1); expect(f.sockets.size).toBe(1)
    } finally { await f.cleanup() }
  }, 30000)
})
