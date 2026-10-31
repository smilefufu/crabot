import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { deduplicatePackages, pruneBuildFiles } from '../slim-core.mjs'

test('deduplication preserves actual Node imports, different versions, dependencies and licenses', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'crabot-slim-test-'))
  async function pkg(module, version, dependencies) {
    const directory = join(root, module, 'node_modules/zod')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'zod', version, main: 'index.cjs', dependencies }))
    await fs.writeFile(join(directory, 'index.cjs'), 'module.exports=' + JSON.stringify(version))
    await fs.writeFile(join(directory, 'LICENSE'), 'retained package license')
    return directory
  }
  try {
    const first = await pkg('crabot-admin', '1'), second = await pkg('crabot-agent', '1')
    const different = await pkg('crabot-channel-slack', '2'), dependent = await pkg('crabot-channel-feishu', '1', { dependency: '1' })
    assert.ok(await deduplicatePackages(root) > 0)
    for (const module of ['crabot-admin', 'crabot-agent']) assert.equal(createRequire(join(root, module, 'consumer.cjs'))('zod'), '1')
    for (const directory of [first, second]) await assert.rejects(fs.lstat(directory), { code: 'ENOENT' })
    assert.equal(createRequire(join(root, 'crabot-channel-slack/consumer.cjs'))('zod'), '2')
    await fs.access(join(dependent, 'package.json')); await fs.access(join(different, 'index.cjs'))
    assert.equal(await fs.readFile(join(root, 'node_modules/zod/LICENSE'), 'utf8'), 'retained package license')
    assert.equal(await deduplicatePackages(root), 0)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('pruning removes compiler outputs and Windows documentation while retaining tools and licenses', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'crabot-prune-test-'))
  const removed = ['crabot-native/build/Release/helper.obj', '.product-runtime/git/ucrt64/share/doc/git-doc/git.html', '.product-runtime/git/usr/share/vim/vim92/doc/help.txt']
  const retained = ['crabot-native/build/Release/helper.exe', 'crabot-native/build/Release/crabot-native.node', '.product-runtime/git/ucrt64/share/doc/LICENSE', '.product-runtime/git/usr/share/vim/vim92/syntax/javascript.vim', '.product-runtime/git/usr/bin/bash.exe']
  try {
    for (const file of [...removed, ...retained]) { await fs.mkdir(join(root, file, '..'), { recursive: true }); await fs.writeFile(join(root, file), 'fixture') }
    assert.deepEqual([...(await pruneBuildFiles(root, 'win32'))].sort(), removed.sort())
    for (const file of retained) await fs.access(join(root, file))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
