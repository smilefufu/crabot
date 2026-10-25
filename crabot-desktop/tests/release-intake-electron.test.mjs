import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync, randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { signDesktopReleaseManifest } from '../../scripts/desktop/sign-release.mjs'
const require = createRequire(import.meta.url), admin = createRequire(new URL('../../crabot-admin/package.json', import.meta.url))
const repository = fileURLToPath(new URL('../../', import.meta.url)), python = process.env.CRABOT_TEST_PYTHON
assert.ok(python && path.isAbsolute(python), 'Use the verified bundled Python through test-paired-release-intake.mjs')
for (const mode of ['discard', 'failed-verification']) test('actual ASAR-hosted intake cleans nested archive bytes: ' + mode, { timeout: 30000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot nested ASAR intake ')))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const source = path.join(root, 'source'), inner = path.join(root, 'inner'), profile = path.join(root, 'profile'), asar = require('@electron/asar')
  await fs.mkdir(path.join(source, 'dist'), { recursive: true }); await fs.mkdir(profile)
  await require('esbuild').build({ entryPoints: [path.join(repository, 'crabot-desktop/src/release-intake.ts')],
    outfile: path.join(source, 'dist/release-intake.js'), bundle: true, platform: 'node', format: 'esm', external: ['original-fs'], logLevel: 'silent' })
  await fs.cp(path.join(repository, 'crabot-desktop/dist/bootstrap'), path.join(source, 'dist/bootstrap'), { recursive: true })
  await fs.writeFile(path.join(source, 'package.json'), '{"type":"module"}')
  await asar.createPackageWithOptions(source, path.join(root, 'app.asar'), { unpack: '**/*.node' })
  await fs.mkdir(path.join(inner, 'dist'), { recursive: true })
  await fs.writeFile(path.join(inner, 'package.json'), '{"main":"dist/main.js"}')
  await fs.writeFile(path.join(inner, 'dist/main.js'), 'throw new Error("inner application must never execute")')
  await asar.createPackage(inner, path.join(root, 'inner.asar'))
  const zip = new (admin('adm-zip'))()
  for (const [name, bytes] of [['desktop-payload.json', Buffer.from('{}\n')], ['core/program.txt', Buffer.from('inert, never execute')],
    ['gui/resources/app.asar', await fs.readFile(path.join(root, 'inner.asar'))]]) zip.addFile(name, bytes, '', 0o100644)
  const bytes = zip.toBuffer(), key = generateKeyPairSync('ed25519'), selection = { schema_version: 1, version: '1.2.3', gui_id: randomUUID(), core_id: 'a'.repeat(64) }
  await fs.writeFile(path.join(root, 'Crabot.zip'), bytes)
  const signed = signDesktopReleaseManifest({ schema_version: 1, app_id: 'com.crabot.desktop', platform: process.platform, arch: process.arch, selection,
    artifact: { file: 'Crabot.zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }, [key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()])
  await fs.writeFile(path.join(root, 'manifest.json'), signed.manifest); await fs.writeFile(path.join(root, 'signatures.json'), signed.signatures)
  await fs.writeFile(path.join(root, 'preserved.txt'), 'outside the disposable stage')
  const config = path.join(root, 'config.json')
  await fs.writeFile(config, JSON.stringify({ root, mode, python, selection, publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() }))
  const env = { ...process.env, CRABOT_RELEASE_INTAKE_FIXTURE_CONFIG: config }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET']) delete env[name]
  const executable = require('electron'), actor = fileURLToPath(new URL('./release-intake-electron.cjs', import.meta.url))
  const result = await promisify(execFile)(process.platform === 'linux' ? 'xvfb-run' : executable,
    process.platform === 'linux' ? ['-a', executable, actor] : [actor], { env, cwd: root, timeout: 20000, maxBuffer: 65536 }).catch(error => {
      for (const line of String(error.stdout ?? '').split('\n')) if (line.startsWith('{"component":"desktop-release-intake"')) console.log(line)
      throw error
    })
  assert.match(result.stdout, /"cleanup_completed":true/)
  assert.match(result.stdout, /"nested_real_asar":true/)
  console.log(result.stdout.trim())
})
