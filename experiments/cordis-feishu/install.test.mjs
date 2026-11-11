import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { install, DOMESTIC_REGISTRY } from './install.mjs'

test('domestic default is explicit; npm registry failure leaves no usable install and does not overwrite existing directories', async () => {
  assert.equal(DOMESTIC_REGISTRY, 'https://registry.npmmirror.com')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cordis-registry-test-'))
  const requests = []
  const server = http.createServer((req, res) => { requests.push(req.url); res.writeHead(404).end('{}') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const root = path.join(dir, 'new-install')
    await assert.rejects(install(root, 'crabot-channel-feishu@0.1.0', `http://127.0.0.1:${server.address().port}`))
    assert.ok(requests.includes('/cordis'))
    await assert.rejects(fs.stat(root), { code: 'ENOENT' })
    const existing = path.join(dir, 'existing')
    await fs.mkdir(existing)
    await fs.writeFile(path.join(existing, 'keep'), 'usable version')
    await assert.rejects(install(existing, 'crabot-channel-feishu@0.1.0'))
    assert.equal(await fs.readFile(path.join(existing, 'keep'), 'utf8'), 'usable version')
  } finally {
    await new Promise(resolve => server.close(resolve))
    await fs.rm(dir, { recursive: true, force: true })
  }
})
