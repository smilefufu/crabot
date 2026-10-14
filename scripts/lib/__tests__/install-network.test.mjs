import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectPackageSource, packageEnvironment, withPackageSource } from '../install-network.mjs'

const silent = { info() {}, warn() {} }
test('available domestic registry is selected once without contacting official', async () => {
  const calls = []
  const source = await selectPackageSource('npm', { logger: silent, probe: async url => { calls.push(url); return true } })
  assert.equal(source.url, 'https://registry.npmmirror.com')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].startsWith(source.url))
})
test('unavailable domestic registry selects official immediately', async () => {
  const source = await selectPackageSource('python', { logger: silent, probe: async () => false })
  assert.equal(source.url, 'https://pypi.org/simple')
})
test('package preparation retries official only once and retains the remaining budget', async () => {
  const source = await selectPackageSource('python', { logger: silent, probe: async () => true })
  const calls = []
  await withPackageSource(source, async (url, env, remaining) => {
    calls.push({ url, remaining })
    if (calls.length === 1) { await new Promise(resolve => setTimeout(resolve, 15)); throw new Error('HTTP 403 Forbidden fetching hatchling index') }
  }, { logger: silent, timeout: 1000 })
  assert.deepEqual(calls.map(c => c.url), ['https://mirrors.aliyun.com/pypi/simple/', 'https://pypi.org/simple'])
  assert.ok(calls[1].remaining < calls[0].remaining)
  assert.equal(source.url, 'https://pypi.org/simple')
})
for (const message of ['Hash mismatch for wheel', 'Cannot find matching keyid', 'EPERM: permission denied', 'ENOSPC: no space', 'compiler exited with code 1', 'unexpected failure']) {
  test(`terminal preparation error does not retry: ${message}`, async () => {
    const source = await selectPackageSource('npm', { logger: silent, probe: async () => true })
    let count = 0
    await assert.rejects(withPackageSource(source, async () => { count++; throw new Error(message) }, { logger: silent }), error => error.message === message)
    assert.equal(count, 1)
  })
}
test('official failure is terminal and retains domestic error context', async () => {
  const source = await selectPackageSource('python', { logger: silent, probe: async () => true })
  let count = 0
  await assert.rejects(withPackageSource(source, async () => { count++; throw new Error('HTTP 403 Forbidden fetching index') }, { logger: silent }), /domestic.*official/is)
  assert.equal(count, 2)
})
test('exhausted budget and cancellation do not start an official attempt', async () => {
  for (const message of ['HTTP 403 Forbidden', 'preparation cancelled']) {
    const source = await selectPackageSource('python', { logger: silent, probe: async () => true })
    let count = 0
    await assert.rejects(withPackageSource(source, async () => {
      count++
      await new Promise(resolve => setTimeout(resolve, 15))
      throw new Error(message)
    }, { logger: silent, timeout: 5 }))
    assert.equal(count, 1)
  }
})
test('public registry settings and credentials stay in a child environment; proxy and CA remain', () => {
  const parent = { PATH: 'tools', HTTPS_PROXY: 'http://localhost:7890', SSL_CERT_FILE: 'company-ca.pem', UV_PYTHON: 'conda-python', COREPACK_NPM_TOKEN: 'secret', COREPACK_INTEGRITY_KEYS: '0', UV_INDEX_URL: 'https://private.example/simple', UV_INSECURE_HOST: 'mirror.example', npm_config_registry: 'https://private.example', npm_config_strict_ssl: 'false' }
  const original = { ...parent }
  const node = packageEnvironment('npm', 'https://registry.npmmirror.com', parent)
  assert.equal(node.npm_config_registry, 'https://registry.npmmirror.com')
  assert.equal(node.COREPACK_NPM_REGISTRY, node.npm_config_registry)
  assert.equal(node.COREPACK_NPM_TOKEN, undefined)
  assert.equal(node.COREPACK_INTEGRITY_KEYS, undefined)
  assert.equal(node.npm_config_strict_ssl, 'true')
  const python = packageEnvironment('python', 'https://mirrors.aliyun.com/pypi/simple/', parent)
  assert.equal(python.UV_INDEX, 'https://mirrors.aliyun.com/pypi/simple/')
  assert.equal(python.UV_INSECURE_HOST, undefined)
  for (const key of ['PATH', 'HTTPS_PROXY', 'SSL_CERT_FILE', 'UV_PYTHON']) assert.equal(python[key], parent[key])
  assert.deepEqual(parent, original)
})

test('private npm config is excluded while proxy and CA are preserved; owned configs are removed', async () => {
  const { mkdtemp, writeFile, readFile, access, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'npm-config-test-'))
  const file = join(root, '.npmrc')
  const certificate = join(root, 'company-ca.pem')
  const config = `_auth=private-secret\nregistry=https://private.invalid\ncafile=${certificate}\nhttps-proxy=http://127.0.0.1:7890\n`
  await writeFile(file, config)
  let owned
  try {
    const source = await selectPackageSource('npm', { probe: async () => true, logger: silent })
    await withPackageSource(source, async (url, env) => {
      assert.notEqual(env.npm_config_userconfig, file)
      assert.equal(await readFile(env.npm_config_userconfig, 'utf8'), '')
      assert.equal(await readFile(env.npm_config_globalconfig, 'utf8'), '')
      assert.equal(env.npm_config_cafile, certificate)
      assert.equal(env.npm_config_https_proxy, 'http://127.0.0.1:7890')
      owned = env.npm_config_userconfig
    }, { env: { ...process.env, npm_config_userconfig: file }, logger: silent })
    await assert.rejects(access(owned))
    assert.equal(await readFile(file, 'utf8'), config)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('uv missing locked version retries official once without changing the requirement', async () => {
  const source = await selectPackageSource('python', { probe: async () => true, logger: silent })
  const requirement = 'hatchling==999999.0.0'
  const calls = []
  await withPackageSource(source, async url => {
    calls.push({ url, requirement })
    if (calls.length === 1) throw new Error(`Because there is no version of ${requirement} and you require ${requirement}, requirements are unsatisfiable`)
  }, { logger: silent })
  assert.deepEqual(calls, [{ url: source.domestic, requirement }, { url: source.official, requirement }])
})

test('Windows environment name casing cannot forward authentication or disable verification', () => {
  const parent = { corepack_npm_token: 'private', corepack_integrity_keys: '0', uv_insecure_host: 'mirrors.aliyun.com', uv_no_verify_hashes: '1', uv_index_private_password: 'private' }
  const npm = packageEnvironment('npm', 'https://registry.npmmirror.com', parent)
  const python = packageEnvironment('python', 'https://mirrors.aliyun.com/pypi/simple/', parent)
  assert.equal(npm.corepack_npm_token, undefined)
  assert.equal(npm.corepack_integrity_keys, undefined)
  assert.equal(python.uv_insecure_host, undefined)
  assert.equal(python.uv_no_verify_hashes, undefined)
  assert.equal(python.uv_index_private_password, undefined)
  assert.equal(parent.corepack_npm_token, 'private')
})
