import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { downloadProductAsset } from '../product-prepare.mjs'

const content = 'verified product bytes'
const asset = { url: 'https://upstream.example/tool.tar.gz', sha256: createHash('sha256').update(content).digest('hex') }
async function directory(t) {
  const target = await mkdtemp(join(tmpdir(), 'crabot-asset-'))
  t.after(() => rm(target, { recursive: true, force: true }))
  return target
}

test('a hash mismatch never leaves a usable or partial cache entry', async t => {
  const target = await directory(t)
  await assert.rejects(downloadProductAsset(asset, target, { fetcher: async () => new Response('corrupt') }), /SHA-256/)
  assert.deepEqual(await readdir(target), [])
})

test('verified cache reuse does not contact the network; corruption forces revalidation', async t => {
  const target = await directory(t)
  let requests = 0
  const options = { fetcher: async () => { requests++; return new Response(content) } }
  const file = await downloadProductAsset(asset, target, options)
  await downloadProductAsset(asset, target, options)
  assert.equal(requests, 1)
  await writeFile(file, 'damaged')
  await downloadProductAsset(asset, target, options)
  assert.equal(requests, 2)
})

test('release redirects carry no credentials and remain HTTPS and hash constrained', async t => {
  const target = await directory(t)
  const visited = []
  await downloadProductAsset(asset, target, { fetcher: async (url, options) => {
    visited.push(url)
    assert.equal(options.redirect, 'manual')
    assert.equal(options.headers, undefined)
    return visited.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://assets.example/tool' } }) : new Response(content)
  } })
  assert.deepEqual(visited, [asset.url, 'https://assets.example/tool'])
})

test('HTTP downgrade and endless redirects cannot be followed indefinitely', async t => {
  const target = await directory(t)
  let requests = 0
  await assert.rejects(downloadProductAsset(asset, target, { fetcher: async () => {
    requests++
    return new Response(null, { status: 302, headers: { location: 'http://unsafe.example/tool' } })
  } }), /HTTPS/)
  assert.equal(requests, 1)
  requests = 0
  await assert.rejects(downloadProductAsset(asset, target, { fetcher: async () => {
    requests++
    return new Response(null, { status: 302, headers: { location: '/loop' } })
  } }), /redirect/)
  assert.equal(requests, 6)
  assert.deepEqual(await readdir(target), [])
})

test('cancel before download performs no network call and leaves no partial files', async t => {
  const target = await directory(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(downloadProductAsset(asset, target, { signal: controller.signal, fetcher: async () => { assert.fail('unexpected network call') } }), /abort/i)
  assert.deepEqual(await readdir(target), [])
})

test('transient connection failure retries once within the same asset budget; final diagnostic excludes raw errors', async t => {
  const target = await directory(t)
  let requests = 0
  await downloadProductAsset(asset, target, { fetcher: async () => {
    if (++requests === 1) throw new TypeError('sensitive transport detail', { cause: { code: 'ECONNRESET' } })
    return new Response(content)
  } })
  assert.equal(requests, 2)
  await rm(target, { recursive: true })
  requests = 0
  await assert.rejects(downloadProductAsset(asset, target, { fetcher: async () => {
    requests++; throw new TypeError('sensitive transport detail', { cause: { code: 'ECONNRESET' } })
  } }), error => error.message.includes('tool.tar.gz') && error.message.includes('ECONNRESET') && !error.message.includes('sensitive'))
  assert.equal(requests, 2)
  assert.deepEqual(await readdir(target), [])
})
