// Native CI: published stopped CLI data -> fixed bundled Node admission ->
// ordinary sealed Mac App. Dialog consent itself has separate component tests.
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs, constants, createReadStream, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.platform, 'darwin')
const repository = await fs.realpath(process.env.GITHUB_WORKSPACE), project = await fs.realpath(process.argv[2])
const location = JSON.parse(await fs.readFile(path.join(project, 'packaged-location.json'), 'utf8'))
assert.equal(location.schema_version, 1)
const originalCore = path.resolve(project, location.core), originalApp = path.resolve(originalCore, '../../..')
assert.equal(path.basename(originalApp), 'Crabot.app')
const temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot App 旧数据 '))), app = path.join(temporary, 'Crabot.app')
await fs.cp(originalApp, app, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
const core = path.join(app, 'Contents/Resources/core'), node = path.join(core, '.product-runtime/node/bin/node'), execute = promisify(execFile)
const archives = JSON.parse(await fs.readFile(new URL('fixtures/legacy-desktop-archives.json', import.meta.url), 'utf8'))
const reports = []
const moduleAt = name => import(pathToFileURL(path.join(core, 'scripts/lib', name)).href)
const { default: binding } = await moduleAt('mac-app-binding.cjs')
const { inspectInstance } = await moduleAt('instance-runtime.mjs')
const { stopInstance } = await moduleAt('instance-controller.mjs')
try {
  for (const version of Object.keys(archives)) {
    const home = path.join(temporary, version), old = path.join(home, '.crabot'), data = path.join(old, 'data')
    const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin', DATA_DIR: data }
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET', 'WORKER_WORKSPACES_DIR']) delete env[name]
    await fs.mkdir(home, { mode: 0o700 })
    const archive = path.join(home, 'old.tar.gz'), extracted = path.join(home, 'extracted')
    const [size, sha256] = archives[version]['darwin-' + process.arch]
    const response = await fetch(`https://github.com/smilefufu/crabot/releases/download/${version}/crabot-${version}-darwin-${process.arch}.tar.gz`, { signal: AbortSignal.timeout(120_000) })
    assert.ok(response.ok && response.body)
    let bytes = 0
    await pipeline(Readable.fromWeb(response.body), async function* (chunks) { for await (const chunk of chunks) { bytes += chunk.length; assert.ok(bytes <= size); yield chunk } }, createWriteStream(archive, { flags: 'wx', mode: 0o600 }))
    assert.equal(bytes, size)
    const hash = createHash('sha256'); for await (const chunk of createReadStream(archive)) hash.update(chunk)
    assert.equal(hash.digest('hex'), sha256)
    await fs.mkdir(extracted); await execute('/usr/bin/tar', ['-xf', archive, '-C', extracted], { timeout: 180_000 })
    const entries = await fs.readdir(extracted); assert.equal(entries.length, 1)
    await fs.rename(path.join(extracted, entries[0]), old); await fs.writeFile(path.join(old, 'VERSION'), version + '\n')
    await fs.mkdir(data, { mode: 0o755 })
    for (const name of ['admin', 'agent', 'memory']) {
      await fs.mkdir(path.join(data, name), { mode: 0o755 })
      const schema = path.join(old, 'crabot-' + name, 'schema_version')
      try { await fs.copyFile(schema, path.join(data, name, 'SCHEMA_VERSION')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const { newCredentialsFromPassword } = await import(pathToFileURL(path.join(core, 'crabot-admin/dist/credentials.js')).href)
    const credentials = JSON.stringify(await newCredentialsFromPassword('fixture-legacy-password', { is_temp: false, changed_via: 'start' }))
    await fs.writeFile(path.join(data, 'admin/credentials.json'), credentials, { mode: 0o600 })
    const sentinels = ['agent/preserved-history.txt', 'memory/preserved.txt', 'mcp-deps/preserved.txt', 'workspaces/project/content.txt']
    for (const file of sentinels) { await fs.mkdir(path.dirname(path.join(data, file)), { recursive: true }); await fs.writeFile(path.join(data, file), 'retained ' + version) }
    const command = path.join(home, '.local/bin/crabot')
    await fs.mkdir(path.dirname(command), { recursive: true }); await fs.symlink(path.join(old, 'cli.mjs'), command)
    binding.writeMacAppBinding({ home, appPath: app, dataDir: data })
    let gui, exited, output = '', passed = false
    try {
      console.log('CRABOT_MAC_APP_LEGACY_STAGE ' + JSON.stringify({ version, stage: 'actual-bundled-admission' }))
      const admission = spawn(node, [path.join(core, 'scripts/mac-adopt-legacy.mjs'), old], { cwd: core, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      let handedOff = false, failureCode
      admission.stderr.on('data', chunk => { output = (output + chunk).slice(-128_000) })
      admission.on('message', frame => {
        output = (output + JSON.stringify(frame) + '\n').slice(-128_000)
        if (frame.type === 'handoff') handedOff = frame.result?.dataDir === data && frame.result.verification_pending === true
        if (frame.type === 'failure') failureCode = frame.code
      })
      const admissionTimer = setTimeout(() => admission.kill('SIGTERM'), 600_000)
      try { assert.equal((await once(admission, 'close'))[0], 0, failureCode ?? output); assert.equal(handedOff, true) }
      finally { clearTimeout(admissionTimer) }
      assert.equal(JSON.parse(await fs.readFile(path.join(data, 'desktop-maintenance.json'), 'utf8')).phase, 'verifying')
      assert.equal(await fs.readlink(command), path.join(core, 'bin/crabot'))
      gui = spawn(path.join(app, 'Contents/MacOS/Crabot'), ['--background'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      exited = once(gui, 'close'); let ready = false, failure, buffered = ''
      gui.once('error', error => { failure = error })
      gui.stderr.on('data', chunk => { output = (output + chunk).slice(-128_000) })
      gui.stdout.on('data', chunk => {
        output = (output + chunk).slice(-128_000); buffered += chunk
        let end
        while ((end = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1)
          try { const event = JSON.parse(line); if (event.component === 'desktop' && event.phase === 'ready') ready = true; if (event.component === 'desktop' && ['error', 'migration_required'].includes(event.phase)) failure = new Error(line) } catch {}
        }
      })
      const deadline = Date.now() + 180_000
      while (true) {
        if (failure || gui.exitCode !== null || gui.signalCode !== null || Date.now() >= deadline) throw failure || new Error('Ordinary Mac App legacy readiness failed\n' + output)
        const maintenance = await fs.lstat(path.join(data, 'desktop-maintenance.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        if (ready && !maintenance) break
        await new Promise(done => setTimeout(done, 100))
      }
      const current = inspectInstance(data); assert.equal(current.state, 'running'); assert.equal(current.record.install_root, core)
      const status = JSON.parse((await execute(command, ['status', '--json'], { env: { ...env, PATH: '/no-host-node' }, timeout: 30_000 })).stdout)
      assert.equal(status.running, true); assert.equal(status.data_dir, data)
      assert.equal(await fs.readFile(path.join(data, 'admin/credentials.json'), 'utf8'), credentials)
      for (const file of sentinels) assert.equal(await fs.readFile(path.join(data, file), 'utf8'), 'retained ' + version)
      for (const file of ['app', 'releases', 'current-release.json', 'desktop-installation.json']) await assert.rejects(fs.lstat(path.join(old, file)), { code: 'ENOENT' })
      reports.push({ version, published_program_verified: true, stopped_fixture_data: true, actual_bundled_admission: true,
        ordinary_sealed_gui_ready: true, cli_same_instance_without_host_node: true, original_data_and_password_preserved: true,
        legacy_root_not_reinstalled: true, native_consent_dialog_tested: false, business_model_calls: 0 })
      passed = true
      console.log('CRABOT_MAC_APP_LEGACY_VERIFIED ' + JSON.stringify(reports.at(-1)))
    } finally {
      await fs.writeFile(path.join(repository, '.desktop-build/mac-app-legacy-' + version + '.log'), output)
      if (inspectInstance(data).state === 'running') await stopInstance(data)
      if (gui && gui.exitCode === null && gui.signalCode === null) gui.kill('SIGTERM')
      if (exited) await exited
      if (passed) await fs.rm(home, { recursive: true, force: true })
    }
  }
  await fs.writeFile(path.join(repository, '.desktop-build/mac-app-legacy.json'), JSON.stringify({ complete: true, cases: reports }) + '\n')
} finally { await fs.rm(temporary, { recursive: true, force: true }) }
